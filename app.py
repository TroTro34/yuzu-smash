from flask import Flask, redirect, request, session, url_for, render_template, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
import requests
import os
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "yuzu_dev_secret")
app.config["SESSION_COOKIE_SECURE"] = True
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["PERMANENT_SESSION_LIFETIME"] = 86400

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet",
                    logger=False, engineio_logger=False)

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

def sb_post(table, data):
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=sb_headers(), json=data)
    return r.json() if r.ok else None

def sb_patch(table, match, data):
    params = "&".join([f"{k}=eq.{v}" for k, v in match.items()])
    r = requests.patch(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=sb_headers(), json=data)
    return r.ok

def sb_delete(table, match):
    params = "&".join([f"{k}=eq.{v}" for k, v in match.items()])
    r = requests.delete(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=sb_headers())
    return r.ok

def calc_elo(winner_pts, loser_pts):
    expected = 1 / (1 + 10 ** ((loser_pts - winner_pts) / 400))
    change = round(ELO_K * (1 - expected))
    return max(change, 1)

def calc_elo_stocks(winner_pts, loser_pts, winner_stocks_taken, loser_stocks_taken):
    expected = 1 / (1 + 10 ** ((loser_pts - winner_pts) / 400))
    base = ELO_K * (1 - expected)
    total = winner_stocks_taken + loser_stocks_taken
    diff_ratio = (winner_stocks_taken - loser_stocks_taken) / total if total > 0 else 0
    multiplier = 1.0 + (diff_ratio * 0.5)
    return max(round(base * multiplier), 1)

def push_dashboard(user_id):
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_players    = ex.submit(sb_get, "players", "order=points.desc")
        f_challenges = ex.submit(sb_get, "challenges", "status=neq.completed&status=neq.declined&status=neq.disputed")
        players        = f_players.result()
        all_challenges = f_challenges.result()
    player = next((p for p in players if p["id"] == user_id), None)
    rank   = next((i + 1 for i, p in enumerate(players) if p["id"] == user_id), None)
    challenges_received = {c["id"]: c for c in all_challenges if c["challenged_id"] == user_id and c["status"] == "pending"}
    active_matches      = {c["id"]: c for c in all_challenges if c["status"] == "accepted" and user_id in [c["challenger_id"], c["challenged_id"]]}
    awaiting            = {c["id"]: c for c in all_challenges if c["status"] == "reported" and c.get("reported_by") != user_id and user_id in [c["challenger_id"], c["challenged_id"]]}
    my_matches = sb_get("matches", f"or=(winner_id.eq.{user_id},loser_id.eq.{user_id})&order=id.desc&limit=10")
    socketio.emit("dashboard_update", {
        "player": player, "players": players, "rank": rank,
        "challenges_received": challenges_received,
        "active_matches": active_matches,
        "awaiting_confirmation": awaiting,
        "my_matches": my_matches
    }, room=f"user_{user_id}")

def push_leaderboard():
    now = datetime.utcnow().isoformat()
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_players = ex.submit(sb_get, "players", "order=points.desc")
        f_matches = ex.submit(sb_get, "matches", "order=id.desc&limit=10")
        f_lfm     = ex.submit(sb_get, "lfm_posts", f"expires_at=gt.{now}&order=created_at.desc")
        players, matches, lfm = f_players.result(), f_matches.result(), f_lfm.result()
    socketio.emit("leaderboard_update", {
        "players": players, "recent_matches": matches, "lfm_posts": lfm
    }, room="global")

@socketio.on("connect")
def on_connect():
    join_room("global")
    if "user" in session:
        join_room(f"user_{session['user']['id']}")

@socketio.on("disconnect")
def on_disconnect():
    if "user" in session:
        leave_room(f"user_{session['user']['id']}")
    leave_room("global")

@app.route("/")
def index():
    user = session.get("user")
    now = datetime.utcnow().isoformat()
    sb_delete("lfm_posts", {"expires_at": f"lt.{now}"})
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_players = ex.submit(sb_get, "players", "order=points.desc")
        f_matches = ex.submit(sb_get, "matches", "order=id.desc&limit=10")
        f_lfm     = ex.submit(sb_get, "lfm_posts", "order=created_at.desc")
        players, matches, lfm = f_players.result(), f_matches.result(), f_lfm.result()
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
    guilds = requests.get("https://discord.com/api/users/@me/guilds", headers=headers).json()
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
        push_leaderboard()
    else:
        sb_patch("players", {"id": uid}, {"username": user_data["username"], "avatar": user_data.get("avatar")})
    return redirect(url_for("dashboard"))

@app.route("/dashboard")
def dashboard():
    if "user" not in session:
        return redirect(url_for("index"))
    user_id = session["user"]["id"]
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_players    = ex.submit(sb_get, "players", "order=points.desc")
        f_challenges = ex.submit(sb_get, "challenges", "status=neq.completed&status=neq.declined&status=neq.disputed")
        players      = f_players.result()
        all_challenges = f_challenges.result()
    player = next((p for p in players if p["id"] == user_id), None)
    rank   = next((i + 1 for i, p in enumerate(players) if p["id"] == user_id), None)
    challenges_received = {c["id"]: c for c in all_challenges if c["challenged_id"] == user_id and c["status"] == "pending"}
    active_matches      = {c["id"]: c for c in all_challenges if c["status"] == "accepted" and user_id in [c["challenger_id"], c["challenged_id"]]}
    awaiting            = {c["id"]: c for c in all_challenges if c["status"] == "reported" and c.get("reported_by") != user_id and user_id in [c["challenger_id"], c["challenged_id"]]}
    my_matches = sb_get("matches", f"or=(winner_id.eq.{user_id},loser_id.eq.{user_id})&order=id.desc&limit=10")
    return render_template("dashboard.html",
        user=session["user"], player=player, players=players, rank=rank,
        challenges_received=challenges_received, active_matches=active_matches,
        awaiting_confirmation=awaiting, my_matches=my_matches)

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
    push_leaderboard()
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
    push_dashboard(opponent_id)
    return jsonify({"success": True})

@app.route("/challenge/<challenge_id>/accept", methods=["POST"])
def accept_challenge(challenge_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    fmt = request.json.get("format", "BO3")
    if fmt not in ["BO1", "BO3", "BO5", "STOCKS"]: return jsonify({"error": "Invalid format"}), 400
    challenges = sb_get("challenges", f"id=eq.{challenge_id}")
    sb_patch("challenges", {"id": challenge_id}, {"status": "accepted", "format": fmt})
    if challenges:
        c = challenges[0]
        push_dashboard(c["challenger_id"])
        push_dashboard(c["challenged_id"])
    return jsonify({"success": True})

@app.route("/challenge/<challenge_id>/decline", methods=["POST"])
def decline_challenge(challenge_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    challenges = sb_get("challenges", f"id=eq.{challenge_id}")
    sb_patch("challenges", {"id": challenge_id}, {"status": "declined"})
    if challenges:
        push_dashboard(challenges[0]["challenger_id"])
    return jsonify({"success": True})

@app.route("/lfm", methods=["POST"])
def create_lfm():
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    user_id = session["user"]["id"]
    data = request.json
    sb_delete("lfm_posts", {"player_id": user_id})
    player = sb_get("players", f"id=eq.{user_id}")
    pts = player[0]["points"] if player else 1000
    main = player[0].get("main_char", "") if player else ""
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
    push_leaderboard()
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
    push_dashboard(post["player_id"])
    push_leaderboard()
    return jsonify({"success": True})

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
    loser_stocks_taken = int(data.get("loser_stocks_taken", 0))
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
        other_id = c["challenged_id"] if user_id == c["challenger_id"] else c["challenger_id"]
        push_dashboard(other_id)
        push_dashboard(user_id)
        return jsonify({"success": True, "message": "Result submitted! Waiting for opponent confirmation."})

    if c["status"] == "reported" and c.get("reported_by") != user_id:
        report = c.get("report") or {}
        if winner_id == report.get("winner_id"):
            winner = sb_get("players", f"id=eq.{winner_id}")
            loser = sb_get("players", f"id=eq.{loser_id}")
            if winner and loser:
                wp, lp = winner[0]["points"], loser[0]["points"]
                rep_is_stocks = report.get("is_stocks_mode", False)
                if rep_is_stocks:
                    elo_gain = calc_elo_stocks(wp, lp,
                        report.get("winner_stocks_taken", 0),
                        report.get("loser_stocks_taken", 0))
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
                    "loser_id": loser_id, "loser_name": loser[0]["username"],
                    "score": report.get("score", score), "format": c["format"],
                    "elo_change": elo_gain, "date": datetime.now().isoformat()
                })
                sb_patch("challenges", {"id": challenge_id}, {"status": "completed"})
                push_dashboard(winner_id)
                push_dashboard(loser_id)
                push_leaderboard()
                return jsonify({"success": True, "message": f"Match validated! +{elo_gain} ELO for the winner."})
        else:
            sb_patch("challenges", {"id": challenge_id}, {"status": "disputed"})
            push_dashboard(c["challenger_id"])
            push_dashboard(c["challenged_id"])
            return jsonify({"success": True, "message": "Conflict detected! Contact an admin."})
    return jsonify({"error": "Invalid action"}), 400

if __name__ == "__main__":
    socketio.run(app, debug=True)
