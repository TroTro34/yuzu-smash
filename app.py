import hashlib
import json
from flask import Flask, redirect, request, session, url_for, render_template, jsonify
import requests
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "yuzu_dev_secret")
app.config["SESSION_COOKIE_SECURE"] = True
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["PERMANENT_SESSION_LIFETIME"] = 86400

CLIENT_ID = "1504467669712240861"
CLIENT_SECRET = os.environ.get("DISCORD_CLIENT_SECRET", "")
GUILD_ID = "1051577844318339172"
REDIRECT_URI = os.environ.get("REDIRECT_URI", "https://yuzu-smash.onrender.com/callback")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

DISCORD_AUTH_URL = (
    f"https://discord.com/oauth2/authorize"
    f"?client_id={CLIENT_ID}&redirect_uri={REDIRECT_URI}"
    f"&response_type=code&scope=identify guilds"
)

ELO_K = 32

# ── SUPABASE HELPERS ──────────────────────────────────────────────────────────

def sb_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }

def sb_get(table, params=""):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=sb_headers())
    return r.json() if r.ok else []

def get_player_matches(user_id, limit=10):
    """Fetch matches for a player, using two queries as fallback for OR filter issues."""
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_w = ex.submit(sb_get, "matches", f"winner_id=eq.{user_id}&order=date.desc&limit={limit}")
        f_l = ex.submit(sb_get, "matches", f"loser_id=eq.{user_id}&order=date.desc&limit={limit}")
    seen, merged = set(), []
    for m in (f_w.result() or []) + (f_l.result() or []):
        if m["id"] not in seen:
            seen.add(m["id"])
            merged.append(m)
    merged.sort(key=lambda x: x.get("date", ""), reverse=True)
    return merged[:limit]

def sb_post(table, data):
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=sb_headers(), json=data)
    if not r.ok:
        print(f"[sb_post ERROR] {table}: {r.status_code} {r.text}")
    return r.json() if r.ok else None

def sb_patch(table, match, data):
    params = "&".join([f"{k}=eq.{v}" for k, v in match.items()])
    r = requests.patch(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=sb_headers(), json=data)
    if not r.ok:
        print(f"[sb_patch ERROR] {table}: {r.status_code} {r.text}")
    return r.ok

def sb_delete(table, match):
    params = "&".join([f"{k}=eq.{v}" for k, v in match.items()])
    r = requests.delete(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=sb_headers())
    return r.ok

# ── ELO ───────────────────────────────────────────────────────────────────────

def calc_elo(winner_pts, loser_pts):
    expected = 1 / (1 + 10 ** ((loser_pts - winner_pts) / 400))
    return max(round(ELO_K * (1 - expected)), 1)

def calc_elo_stocks(winner_pts, loser_pts, winner_stocks_taken, loser_stocks_taken):
    expected = 1 / (1 + 10 ** ((loser_pts - winner_pts) / 400))
    base = ELO_K * (1 - expected)
    total = winner_stocks_taken + loser_stocks_taken
    diff_ratio = (winner_stocks_taken - loser_stocks_taken) / total if total > 0 else 0
    return max(round(base * (1.0 + diff_ratio * 0.5)), 1)

# ── DATA (requêtes Supabase parallèles) ───────────────────────────────────────

def _dashboard_data(user_id):
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_players    = ex.submit(sb_get, "players", "order=points.desc")
        f_challenges = ex.submit(sb_get, "challenges", "status=in.(pending,accepted,reported)")
        f_matches    = ex.submit(get_player_matches, user_id, 10)

    players        = f_players.result()
    all_challenges = f_challenges.result()
    my_matches     = f_matches.result()

    player = next((p for p in players if p["id"] == user_id), None)
    rank   = next((i + 1 for i, p in enumerate(players) if p["id"] == user_id), None)

    challenges_received = {c["id"]: c for c in all_challenges if c["challenged_id"] == user_id and c["status"] == "pending"}
    challenges_sent     = {c["id"]: c for c in all_challenges if c["challenger_id"] == user_id and c["status"] == "pending"}
    active_matches      = {c["id"]: c for c in all_challenges if c["status"] == "accepted" and user_id in [c["challenger_id"], c["challenged_id"]]}
    awaiting            = {c["id"]: c for c in all_challenges if c["status"] == "reported" and c.get("reported_by") != user_id and user_id in [c["challenger_id"], c["challenged_id"]]}

    return {
        "player": player, "players": players, "rank": rank,
        "challenges_received": challenges_received,
        "challenges_sent": challenges_sent,
        "active_matches": active_matches,
        "awaiting_confirmation": awaiting,
        "my_matches": my_matches
    }

def _leaderboard_data():
    now = datetime.utcnow().isoformat()
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_players = ex.submit(sb_get, "players", "order=points.desc")
        f_matches = ex.submit(sb_get, "matches", "order=date.desc&limit=10")
        f_lfm     = ex.submit(sb_get, "lfm_posts", f"expires_at=gt.{now}&order=created_at.desc")
    return {
        "players":        f_players.result(),
        "recent_matches": f_matches.result(),
        "lfm_posts":      f_lfm.result(),
    }

# ── POLLING API ───────────────────────────────────────────────────────────────

@app.route("/api/dashboard")
def api_dashboard():
    if "user" not in session:
        return jsonify({"error": "Unauthorized"}), 401
    data = _dashboard_data(session["user"]["id"])
    import json
    etag = hashlib.md5(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()
    if request.headers.get("If-None-Match") == etag:
        return "", 304
    resp = jsonify(data)
    resp.headers["ETag"] = etag
    return resp

@app.route("/api/leaderboard")
def api_leaderboard():
    return jsonify(_leaderboard_data())

# ── ROUTES ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    user = session.get("user")
    now = datetime.utcnow().isoformat()
    sb_delete("lfm_posts", {"expires_at": f"lt.{now}"})
    players = sb_get("players", "order=points.desc")
    matches = sb_get("matches", "order=date.desc&limit=10")
    lfm     = sb_get("lfm_posts", "order=created_at.desc")
    return render_template("index.html", user=user, players=players, recent_matches=matches, lfm_posts=lfm)

@app.route("/login")
def login():
    return redirect(DISCORD_AUTH_URL)

@app.route("/callback")
def callback():
    code = request.args.get("code")
    if not code:
        return redirect(url_for("index"))
    r = requests.post(
        "https://discord.com/api/oauth2/token",
        data={"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
              "grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI},
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    if r.status_code != 200:
        return f"Discord Error: {r.text}", 400
    token = r.json().get("access_token")
    headers = {"Authorization": f"Bearer {token}"}
    user_data = requests.get("https://discord.com/api/users/@me", headers=headers).json()
    guilds    = requests.get("https://discord.com/api/users/@me/guilds", headers=headers).json()
    if GUILD_ID not in [g["id"] for g in guilds]:
        return render_template("not_member.html")
    session["user"] = {"id": user_data["id"], "username": user_data["username"], "avatar": user_data.get("avatar")}
    session.permanent = True
    uid = user_data["id"]
    existing = sb_get("players", f"id=eq.{uid}")
    if not existing:
        sb_post("players", {"id": uid, "username": user_data["username"], "avatar": user_data.get("avatar"),
                            "points": 1000, "wins": 0, "losses": 0, "matches_played": 0,
                            "main_char": "", "secondary_char": "", "stocks_taken": 0, "stocks_lost": 0})
    else:
        sb_patch("players", {"id": uid}, {"username": user_data["username"], "avatar": user_data.get("avatar")})
    return redirect(url_for("dashboard"))

@app.route("/dashboard")
def dashboard():
    if "user" not in session:
        return redirect(url_for("login"))
    user_id = session["user"]["id"]
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_players    = ex.submit(sb_get, "players", "order=points.desc")
        f_challenges = ex.submit(sb_get, "challenges", "status=in.(pending,accepted,reported)")
        f_matches    = ex.submit(get_player_matches, user_id, 10)

    players        = f_players.result()
    all_challenges = f_challenges.result()
    my_matches     = f_matches.result()

    player = next((p for p in players if p["id"] == user_id), None)
    rank   = next((i + 1 for i, p in enumerate(players) if p["id"] == user_id), None)
    challenges_received = {c["id"]: c for c in all_challenges if c["challenged_id"] == user_id and c["status"] == "pending"}
    challenges_sent     = {c["id"]: c for c in all_challenges if c["challenger_id"] == user_id and c["status"] == "pending"}
    active_matches      = {c["id"]: c for c in all_challenges if c["status"] == "accepted" and user_id in [c["challenger_id"], c["challenged_id"]]}
    awaiting            = {c["id"]: c for c in all_challenges if c["status"] == "reported" and c.get("reported_by") != user_id and user_id in [c["challenger_id"], c["challenged_id"]]}

    return render_template("dashboard.html",
        user=session["user"], player=player, players=players, rank=rank,
        challenges_received=challenges_received, challenges_sent=challenges_sent,
        active_matches=active_matches,
        awaiting_confirmation=awaiting, my_matches=my_matches)

@app.route("/player/<player_id>")
def player_profile(player_id):
    # Si c'est le joueur connecté, on le redirige vers son dashboard
    if session.get("user", {}).get("id") == player_id:
        return redirect(url_for("dashboard"))
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_players = ex.submit(sb_get, "players", "order=points.desc")
        f_matches = ex.submit(get_player_matches, player_id, 10)
    players   = f_players.result()
    my_matches = f_matches.result()
    player = next((p for p in players if p["id"] == player_id), None)
    if not player:
        return redirect(url_for("index"))
    rank = next((i + 1 for i, p in enumerate(players) if p["id"] == player_id), None)
    return render_template("player_profile.html",
        user=session.get("user"), player=player, rank=rank, my_matches=my_matches)

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))

@app.route("/api/update_profile", methods=["POST"])
def update_profile():
    if "user" not in session:
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    user_id = session["user"]["id"]
    sb_patch("players", {"id": user_id}, {
        "main_char": data.get("main_char", ""),
        "secondary_char": data.get("secondary_char", "")
    })
    return jsonify({"success": True})

@app.route("/api/lfm")
def api_lfm():
    now = datetime.utcnow().isoformat()
    posts = sb_get("lfm_posts", f"expires_at=gt.{now}&order=created_at.desc")
    return jsonify(posts)

@app.route("/api/players/search")
def search_players():
    q = request.args.get("q", "").lower()
    players = sb_get("players", "order=points.desc")
    if q:
        players = [p for p in players if q in p["username"].lower()]
    return jsonify(players)

@app.route("/challenge/<opponent_id>", methods=["POST"])
def challenge(opponent_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    user_id = session["user"]["id"]
    if user_id == opponent_id: return jsonify({"error": "You can't challenge yourself"}), 400
    opponent = sb_get("players", f"id=eq.{opponent_id}")
    if not opponent: return jsonify({"error": "Player not found"}), 404
    existing = sb_get("challenges", f"status=in.(pending,accepted)&or=(and(challenger_id.eq.{user_id},challenged_id.eq.{opponent_id}),and(challenger_id.eq.{opponent_id},challenged_id.eq.{user_id}))")
    if existing: return jsonify({"error": "A challenge is already pending between you"}), 400
    cid = f"ch_{int(datetime.now().timestamp())}_{user_id}"
    sb_post("challenges", {"id": cid, "challenger_id": user_id, "challenger_name": session["user"]["username"],
        "challenged_id": opponent_id, "challenged_name": opponent[0]["username"], "status": "pending", "format": None})
    return jsonify({"success": True})

@app.route("/challenge/<challenge_id>/accept", methods=["POST"])
def accept_challenge(challenge_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    fmt = request.json.get("format", "BO3")
    if fmt not in ["BO1", "BO3", "BO5", "STOCKS"]: return jsonify({"error": "Invalid format"}), 400
    sb_patch("challenges", {"id": challenge_id}, {"status": "accepted", "format": fmt})
    return jsonify({"success": True})

@app.route("/challenge/<challenge_id>/decline", methods=["POST"])
def decline_challenge(challenge_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    sb_patch("challenges", {"id": challenge_id}, {"status": "declined"})
    return jsonify({"success": True})

@app.route("/challenge/<challenge_id>/cancel", methods=["POST"])
def cancel_challenge(challenge_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    user_id = session["user"]["id"]
    challenges = sb_get("challenges", f"id=eq.{challenge_id}")
    if not challenges: return jsonify({"error": "Challenge not found"}), 404
    c = challenges[0]
    if c["challenger_id"] != user_id: return jsonify({"error": "Only the challenger can cancel"}), 403
    if c["status"] != "pending": return jsonify({"error": "Can only cancel pending challenges"}), 400
    sb_delete("challenges", {"id": challenge_id})
    return jsonify({"success": True})

@app.route("/lfm", methods=["POST"])
def create_lfm():
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    user_id = session["user"]["id"]
    data = request.json
    sb_delete("lfm_posts", {"player_id": user_id})
    player = sb_get("players", f"id=eq.{user_id}")
    pts    = player[0]["points"] if player else 1000
    main   = player[0].get("main_char", "") if player else ""
    avatar = session["user"].get("avatar", "")
    expires = (datetime.utcnow() + timedelta(minutes=30)).isoformat()
    post_id = f"lfm_{int(datetime.now().timestamp())}_{user_id}"
    sb_post("lfm_posts", {
        "id": post_id, "player_id": user_id,
        "player_name": session["user"]["username"],
        "player_avatar": avatar, "player_points": pts, "main_char": main,
        "format": data.get("format", "BO3"), "mode": data.get("mode", "sets"),
        "message": data.get("message", ""),
        "created_at": datetime.utcnow().isoformat(), "expires_at": expires
    })
    return jsonify({"success": True})

@app.route("/lfm/<post_id>/accept", methods=["POST"])
def accept_lfm(post_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    user_id = session["user"]["id"]
    posts = sb_get("lfm_posts", f"id=eq.{post_id}")
    if not posts: return jsonify({"error": "Post not found"}), 404
    post = posts[0]
    if post["player_id"] == user_id: return jsonify({"error": "You can't accept your own post"}), 400
    cid = f"ch_{int(datetime.now().timestamp())}_{user_id}"
    sb_post("challenges", {
        "id": cid, "challenger_id": user_id,
        "challenger_name": session["user"]["username"],
        "challenged_id": post["player_id"],
        "challenged_name": post["player_name"],
        "status": "accepted", "format": post["format"]
    })
    sb_delete("lfm_posts", {"id": post_id})
    return jsonify({"success": True})

@app.route("/lfm/<post_id>/cancel", methods=["POST"])
def cancel_lfm(post_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    user_id = session["user"]["id"]
    posts = sb_get("lfm_posts", f"id=eq.{post_id}")
    if not posts: return jsonify({"error": "Post not found"}), 404
    if posts[0]["player_id"] != user_id: return jsonify({"error": "Not your post"}), 403
    sb_delete("lfm_posts", {"id": post_id})
    return jsonify({"success": True})

@app.route("/api/match_status/<challenge_id>")
def api_match_status(challenge_id):
    if "user" not in session:
        return jsonify({"error": "Unauthorized"}), 401
    challenges = sb_get("challenges", f"id=eq.{challenge_id}")
    if not challenges:
        return jsonify({"error": "Not found"}), 404
    c = challenges[0]
    return jsonify({
        "status": c["status"],
        "reported_by": c.get("reported_by"),
        "report": c.get("report"),
        "winner_id": (c.get("report") or {}).get("winner_id") if isinstance(c.get("report"), dict) else None,
        "score": (c.get("report") or {}).get("score") if isinstance(c.get("report"), dict) else None,
    })

@app.route("/match/<challenge_id>")
def match_page(challenge_id):
    if "user" not in session:
        return redirect(url_for("login"))
    user_id = session["user"]["id"]
    challenges = sb_get("challenges", f"id=eq.{challenge_id}")
    if not challenges:
        return redirect(url_for("dashboard"))
    c = challenges[0]
    # Only participants can access the match page
    if user_id not in [c["challenger_id"], c["challenged_id"]]:
        return redirect(url_for("dashboard"))
    if c["status"] not in ["accepted", "reported"]:
        return redirect(url_for("dashboard"))
    # Fetch both players in parallel
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_challenger = ex.submit(sb_get, "players", f"id=eq.{c['challenger_id']}")
        f_challenged = ex.submit(sb_get, "players", f"id=eq.{c['challenged_id']}")
    challenger = f_challenger.result()
    challenged = f_challenged.result()
    if not challenger or not challenged:
        return redirect(url_for("dashboard"))
    return render_template("match.html",
        user=session["user"],
        challenge=c,
        challenger=challenger[0],
        challenged=challenged[0]
    )

@app.route("/result/<challenge_id>", methods=["POST"])
def submit_result(challenge_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    user_id = session["user"]["id"]
    challenges = sb_get("challenges", f"id=eq.{challenge_id}")
    if not challenges: return jsonify({"error": "Challenge not found"}), 404
    c = challenges[0]
    if user_id not in [c["challenger_id"], c["challenged_id"]]: return jsonify({"error": "Not part of this match"}), 403
    data = request.json
    winner_id = data.get("winner_id")
    score = data.get("score", "")
    winner_stocks_taken = int(data.get("winner_stocks_taken", 0))
    loser_stocks_taken  = int(data.get("loser_stocks_taken", 0))
    is_stocks_mode = c["format"] == "STOCKS"
    if is_stocks_mode and not score:
        score = f"{winner_stocks_taken}-{loser_stocks_taken}"
    if winner_id not in [c["challenger_id"], c["challenged_id"]]: return jsonify({"error": "Invalid winner"}), 400
    loser_id = c["challenged_id"] if winner_id == c["challenger_id"] else c["challenger_id"]

    if c["status"] == "accepted":
        sb_patch("challenges", {"id": challenge_id}, {
            "status": "reported", "reported_by": user_id,
            "report": {"winner_id": winner_id, "score": score,
                       "winner_stocks_taken": winner_stocks_taken,
                       "loser_stocks_taken": loser_stocks_taken,
                       "is_stocks_mode": is_stocks_mode}
        })
        return jsonify({"success": True, "message": "Result submitted! Waiting for opponent confirmation."})

    if c["status"] == "reported" and c.get("reported_by") != user_id:
        raw_report = c.get("report") or {}
        # jsonb retourne un dict directement, mais gérer les cas edge (string échappée)
        if isinstance(raw_report, str):
            try:
                # Peut être doublement échappé si ancien bug
                cleaned = raw_report.strip('"').replace('\"', '"')
                report = json.loads(cleaned)
            except Exception:
                report = {}
        elif isinstance(raw_report, dict):
            report = raw_report
        else:
            report = {}
        print(f"[DEBUG report] type={type(raw_report)} val={raw_report} -> winner_id={report.get('winner_id')}")
        if str(winner_id) == str(report.get("winner_id", "")):
            with ThreadPoolExecutor(max_workers=2) as ex:
                f_winner = ex.submit(sb_get, "players", f"id=eq.{winner_id}")
                f_loser  = ex.submit(sb_get, "players", f"id=eq.{loser_id}")
            winner = f_winner.result()
            loser  = f_loser.result()
            if winner and loser:
                wp, lp = winner[0]["points"], loser[0]["points"]
                if report.get("is_stocks_mode"):
                    elo_gain = calc_elo_stocks(wp, lp, report.get("winner_stocks_taken", 0), report.get("loser_stocks_taken", 0))
                else:
                    elo_gain = calc_elo(wp, lp)
                sb_patch("players", {"id": winner_id}, {
                    "points": wp + elo_gain, "wins": winner[0]["wins"] + 1,
                    "matches_played": winner[0]["matches_played"] + 1,
                    "stocks_taken": (winner[0].get("stocks_taken") or 0) + report.get("winner_stocks_taken", 0)
                })
                sb_patch("players", {"id": loser_id}, {
                    "points": max(0, lp - elo_gain), "losses": loser[0]["losses"] + 1,
                    "matches_played": loser[0]["matches_played"] + 1,
                    "stocks_lost": (loser[0].get("stocks_lost") or 0) + report.get("loser_stocks_taken", 0)
                })
                sb_post("matches", {
                    "challenge_id": challenge_id,
                    "winner_id": winner_id, "winner_name": winner[0]["username"],
                    "winner_main": winner[0].get("main_char", ""),
                    "loser_id": loser_id,  "loser_name":  loser[0]["username"],
                    "loser_main": loser[0].get("main_char", ""),
                    "score": report.get("score", score), "format": c["format"],
                    "elo_change": elo_gain, "date": datetime.now().isoformat()
                })
                sb_patch("challenges", {"id": challenge_id}, {"status": "completed"})
                return jsonify({"success": True, "message": f"Match validated! +{elo_gain} ELO for the winner."})
        else:
            sb_patch("challenges", {"id": challenge_id}, {"status": "disputed"})
            return jsonify({"success": True, "message": "Conflict detected! Contact an admin."})

    return jsonify({"error": "Invalid action"}), 400

if __name__ == "__main__":
    app.run(debug=True, threaded=True)
