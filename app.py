from flask import Flask, redirect, request, session, url_for, render_template, jsonify
import requests
import os
from datetime import datetime, timedelta

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "yuzu_dev_secret")
app.config["SESSION_COOKIE_SECURE"] = True
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["PERMANENT_SESSION_LIFETIME"] = 86400

CLIENT_ID     = "1504467669712240861"
CLIENT_SECRET = os.environ.get("DISCORD_CLIENT_SECRET", "")
GUILD_ID      = "1051577844318339172"
REDIRECT_URI  = os.environ.get("REDIRECT_URI", "https://yuzu-smash.onrender.com/callback")
SUPABASE_URL  = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY  = os.environ.get("SUPABASE_KEY", "")

DISCORD_AUTH_URL = (
    f"https://discord.com/oauth2/authorize"
    f"?client_id={CLIENT_ID}&redirect_uri={REDIRECT_URI}"
    f"&response_type=code&scope=identify guilds"
)

# ═══════════════════════════════════════════
# SUPABASE HELPERS
# ═══════════════════════════════════════════
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

# ═══════════════════════════════════════════
# ELO  (start.gg-style)
# ═══════════════════════════════════════════
ELO_K = 32

def calculate_elo(winner_pts, loser_pts):
    expected = 1 / (1 + 10 ** ((loser_pts - winner_pts) / 400))
    gain = round(ELO_K * (1 - expected))
    return winner_pts + gain, max(0, loser_pts - gain), gain

def calculate_elo_stocks(winner_pts, loser_pts, stocks_left, total_stocks):
    """K scales with performance: more stocks left = higher ELO gain."""
    perf = stocks_left / total_stocks        # 0.33 … 1.0
    K    = round(ELO_K * (0.5 + perf))      # K : 16 … 48
    expected = 1 / (1 + 10 ** ((loser_pts - winner_pts) / 400))
    gain = round(K * (1 - expected))
    return winner_pts + gain, max(0, loser_pts - gain), gain

def apply_result(c, winner_id, loser_id, score):
    wr = sb_get("players", f"id=eq.{winner_id}")
    lr = sb_get("players", f"id=eq.{loser_id}")
    if not wr or not lr:
        return None
    w, l = wr[0], lr[0]
    fmt  = c.get("format", "BO3")

    if fmt == "STOCKS":
        total = c.get("stocks", 3) or 3
        try:   left = int(score)
        except: left = 1
        new_w, new_l, gain = calculate_elo_stocks(w["points"], l["points"], left, total)
    else:
        new_w, new_l, gain = calculate_elo(w["points"], l["points"])

    sb_patch("players", {"id": winner_id}, {"points": new_w, "wins": w["wins"] + 1,
                                             "matches_played": w["matches_played"] + 1})
    sb_patch("players", {"id": loser_id},  {"points": new_l, "losses": l["losses"] + 1,
                                             "matches_played": l["matches_played"] + 1})
    sb_post("matches", {
        "challenge_id": c["id"], "winner_id": winner_id, "winner_name": w["username"],
        "loser_id": loser_id, "loser_name": l["username"],
        "score": str(score), "format": fmt, "elo_change": gain,
        "date": datetime.now().isoformat()
    })
    sb_patch("challenges", {"id": c["id"]}, {"status": "completed"})
    return new_w, new_l, gain

# ═══════════════════════════════════════════
# MAIN ROUTES
# ═══════════════════════════════════════════

@app.route("/")
def index():
    user    = session.get("user")
    players = sb_get("players", "order=points.desc")
    matches = sb_get("matches", "order=id.desc&limit=10")
    return render_template("index.html", user=user, players=players, recent_matches=matches)

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
    token     = r.json().get("access_token")
    headers   = {"Authorization": f"Bearer {token}"}
    user_data = requests.get("https://discord.com/api/users/@me",        headers=headers).json()
    guilds    = requests.get("https://discord.com/api/users/@me/guilds", headers=headers).json()
    if GUILD_ID not in [g["id"] for g in guilds]:
        return render_template("not_member.html")
    session["user"] = {"id": user_data["id"], "username": user_data["username"],
                       "avatar": user_data.get("avatar")}
    session.permanent = True
    uid = user_data["id"]
    existing = sb_get("players", f"id=eq.{uid}")
    if not existing:
        sb_post("players", {"id": uid, "username": user_data["username"],
                            "avatar": user_data.get("avatar"), "points": 1000,
                            "wins": 0, "losses": 0, "matches_played": 0,
                            "main_char": None, "secondary_char": None})
    else:
        sb_patch("players", {"id": uid}, {"username": user_data["username"],
                                           "avatar": user_data.get("avatar")})
    return redirect(url_for("dashboard"))

@app.route("/dashboard")
def dashboard():
    if "user" not in session:
        return redirect(url_for("index"))
    uid     = session["user"]["id"]
    players = sb_get("players", "order=points.desc")
    player  = next((p for p in players if p["id"] == uid), None)
    rank    = next((i + 1 for i, p in enumerate(players) if p["id"] == uid), None)
    all_c   = sb_get("challenges", "status=neq.completed&status=neq.declined&order=created_at.desc")
    recv     = {c["id"]: c for c in all_c if c["challenged_id"] == uid and c["status"] == "pending"}
    active   = {c["id"]: c for c in all_c if c["status"] == "accepted"
                and uid in [c["challenger_id"], c["challenged_id"]]}
    awaiting = {c["id"]: c for c in all_c if c["status"] == "reported"
                and (c.get("reported_by") or "") != uid
                and uid in [c["challenger_id"], c["challenged_id"]]}
    my_matches = sb_get("matches",
                        f"or=(winner_id.eq.{uid},loser_id.eq.{uid})&order=id.desc&limit=10")
    return render_template("dashboard.html",
        user=session["user"], player=player, players=players, rank=rank,
        challenges_received=recv, active_matches=active,
        awaiting_confirmation=awaiting, my_matches=my_matches)

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))

# ═══════════════════════════════════════════
# API
# ═══════════════════════════════════════════

@app.route("/api/status")
def api_status():
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    uid   = session["user"]["id"]
    all_c = sb_get("challenges", "status=neq.completed&status=neq.declined&limit=100")
    return jsonify({
        "pending":  sum(1 for c in all_c if c["challenged_id"] == uid and c["status"] == "pending"),
        "active":   sum(1 for c in all_c if c["status"] == "accepted" and uid in [c["challenger_id"], c["challenged_id"]]),
        "awaiting": sum(1 for c in all_c if c["status"] == "reported"
                        and (c.get("reported_by") or "") != uid
                        and uid in [c["challenger_id"], c["challenged_id"]])
    })

@app.route("/api/dashboard_data")
def api_dashboard_data():
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    uid     = session["user"]["id"]
    players = sb_get("players", "order=points.desc")
    player  = next((p for p in players if p["id"] == uid), None)
    rank    = next((i + 1 for i, p in enumerate(players) if p["id"] == uid), None)
    all_c   = sb_get("challenges", "status=neq.completed&status=neq.declined")
    my_matches = sb_get("matches", f"or=(winner_id.eq.{uid},loser_id.eq.{uid})&order=id.desc&limit=10")
    return jsonify({
        "player": player, "players": players, "rank": rank,
        "challenges_received": {c["id"]: c for c in all_c if c["challenged_id"] == uid and c["status"] == "pending"},
        "active_matches":      {c["id"]: c for c in all_c if c["status"] == "accepted" and uid in [c["challenger_id"], c["challenged_id"]]},
        "awaiting_confirmation": {c["id"]: c for c in all_c if c["status"] == "reported"
                                  and (c.get("reported_by") or "") != uid and uid in [c["challenger_id"], c["challenged_id"]]},
        "my_matches": my_matches
    })

# ═══════════════════════════════════════════
# CHARACTERS
# ═══════════════════════════════════════════

@app.route("/character", methods=["POST"])
def set_character():
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    data = request.json or {}
    sb_patch("players", {"id": session["user"]["id"]},
             {"main_char": data.get("main"), "secondary_char": data.get("secondary")})
    return jsonify({"success": True})

# ═══════════════════════════════════════════
# CHALLENGES
# ═══════════════════════════════════════════

@app.route("/challenge/<opponent_id>", methods=["POST"])
def challenge(opponent_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    uid = session["user"]["id"]
    if uid == opponent_id: return jsonify({"error": "You can't challenge yourself"}), 400
    opp = sb_get("players", f"id=eq.{opponent_id}")
    if not opp: return jsonify({"error": "Player not found"}), 404
    existing = sb_get("challenges",
        f"status=in.(pending,accepted)&or=(and(challenger_id.eq.{uid},challenged_id.eq.{opponent_id}),"
        f"and(challenger_id.eq.{opponent_id},challenged_id.eq.{uid}))")
    if existing: return jsonify({"error": "A challenge is already pending between you two"}), 400
    cid = f"ch_{int(datetime.now().timestamp())}_{uid[:6]}"
    sb_post("challenges", {"id": cid, "challenger_id": uid,
        "challenger_name": session["user"]["username"], "challenged_id": opponent_id,
        "challenged_name": opp[0]["username"], "status": "pending", "format": None, "stocks": None,
        "created_at": datetime.now().isoformat()})
    return jsonify({"success": True})

@app.route("/challenge/<cid>/accept", methods=["POST"])
def accept_challenge(cid):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    fmt = (request.json or {}).get("format", "BO3")
    if fmt not in ["BO1", "BO3", "BO5"]: return jsonify({"error": "Invalid format"}), 400
    sb_patch("challenges", {"id": cid}, {"status": "accepted", "format": fmt})
    return jsonify({"success": True})

@app.route("/challenge/<cid>/decline", methods=["POST"])
def decline_challenge(cid):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    sb_patch("challenges", {"id": cid}, {"status": "declined"})
    return jsonify({"success": True})

# ═══════════════════════════════════════════
# RESULTS  (dual-confirm like start.gg)
# ═══════════════════════════════════════════

@app.route("/result/<cid>", methods=["POST"])
def submit_result(cid):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    uid = session["user"]["id"]
    cs  = sb_get("challenges", f"id=eq.{cid}")
    if not cs: return jsonify({"error": "Challenge not found"}), 404
    c = cs[0]
    if uid not in [c["challenger_id"], c["challenged_id"]]:
        return jsonify({"error": "Not your match"}), 403
    data      = request.json or {}
    winner_id = data.get("winner_id")
    score     = data.get("score", "")
    if winner_id not in [c["challenger_id"], c["challenged_id"]]:
        return jsonify({"error": "Invalid winner"}), 400
    loser_id = c["challenged_id"] if winner_id == c["challenger_id"] else c["challenger_id"]

    if c["status"] == "accepted":
        if (c.get("reported_by") or "") == uid:
            return jsonify({"error": "Already reported — wait for your opponent"}), 400
        sb_patch("challenges", {"id": cid}, {"status": "reported", "reported_by": uid,
                                              "report": {"winner_id": winner_id, "loser_id": loser_id, "score": score}})
        return jsonify({"success": True, "message": "Result submitted — waiting for opponent confirmation."})

    if c["status"] == "reported" and (c.get("reported_by") or "") != uid:
        report = c.get("report") or {}
        if winner_id == report.get("winner_id"):
            result = apply_result(c, winner_id, loser_id, report.get("score") or score)
            if not result: return jsonify({"error": "DB error"}), 500
            nw, nl, gain = result
            return jsonify({"success": True, "confirmed": True,
                            "winner_points": nw, "loser_points": nl, "elo_gain": gain})
        else:
            sb_patch("challenges", {"id": cid}, {"status": "disputed"})
            return jsonify({"success": True, "disputed": True,
                            "message": "Conflict — contact an admin."})
    return jsonify({"error": "Invalid action"}), 400

@app.route("/result/<cid>/confirm", methods=["POST"])
def confirm_result(cid):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    uid = session["user"]["id"]
    cs  = sb_get("challenges", f"id=eq.{cid}")
    if not cs or cs[0]["status"] != "reported": return jsonify({"error": "Nothing to confirm"}), 404
    c = cs[0]
    if (c.get("reported_by") or "") == uid: return jsonify({"error": "You filed this report"}), 400
    report = c.get("report") or {}
    wid = report.get("winner_id"); lid = report.get("loser_id"); sc = report.get("score", "")
    result = apply_result(c, wid, lid, sc)
    if not result: return jsonify({"error": "DB error"}), 500
    nw, nl, gain = result
    return jsonify({"success": True, "winner_points": nw, "loser_points": nl, "elo_gain": gain})

@app.route("/result/<cid>/dispute", methods=["POST"])
def dispute_result(cid):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    uid = session["user"]["id"]
    cs  = sb_get("challenges", f"id=eq.{cid}")
    if not cs or cs[0]["status"] != "reported": return jsonify({"error": "Nothing to dispute"}), 404
    if (cs[0].get("reported_by") or "") == uid: return jsonify({"error": "You filed this report"}), 400
    sb_patch("challenges", {"id": cid}, {"status": "disputed", "disputed_by": uid,
                                          "disputed_at": datetime.now().isoformat()})
    return jsonify({"success": True})

# ═══════════════════════════════════════════
# LOOKING FOR MATCH (LFM)
# Expires automatically after 30 min
# Formats: BO1, BO3, BO5, STOCKS
# ═══════════════════════════════════════════

@app.route("/api/lfm")
def get_lfm():
    cutoff  = (datetime.utcnow() - timedelta(minutes=30)).isoformat()
    all_lfm = sb_get("lfm", "status=eq.open&order=created_at.desc")
    return jsonify([l for l in all_lfm if (l.get("created_at") or "") > cutoff])

@app.route("/lfm", methods=["POST"])
def post_lfm():
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    uid  = session["user"]["id"]
    data = request.json or {}
    fmt  = data.get("format")
    if fmt not in ["BO1", "BO3", "BO5", "STOCKS"]:
        return jsonify({"error": "Invalid format"}), 400
    stocks = None
    if fmt == "STOCKS":
        try:
            stocks = int(data.get("stocks", 3))
            if not 1 <= stocks <= 99: raise ValueError
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid stocks value"}), 400
    # Cancel previous open LFM
    for old in sb_get("lfm", f"player_id=eq.{uid}&status=eq.open"):
        sb_patch("lfm", {"id": old["id"]}, {"status": "cancelled"})
    player_rec = sb_get("players", f"id=eq.{uid}")
    p  = player_rec[0] if player_rec else {}
    sb_post("lfm", {"id": f"lfm_{int(datetime.utcnow().timestamp())}_{uid[:6]}",
        "player_id": uid, "player_name": session["user"]["username"],
        "player_avatar": session["user"].get("avatar"),
        "player_points": p.get("points", 1000),
        "main_char": p.get("main_char"), "secondary_char": p.get("secondary_char"),
        "format": fmt, "stocks": stocks, "status": "open",
        "created_at": datetime.utcnow().isoformat()})
    return jsonify({"success": True})

@app.route("/lfm/<lfm_id>/accept", methods=["POST"])
def accept_lfm(lfm_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    uid  = session["user"]["id"]
    recs = sb_get("lfm", f"id=eq.{lfm_id}")
    if not recs: return jsonify({"error": "Not found"}), 404
    lfm = recs[0]
    if lfm["player_id"] == uid: return jsonify({"error": "Cannot accept your own LFM"}), 400
    if lfm["status"] != "open": return jsonify({"error": "No longer available"}), 400
    cutoff = (datetime.utcnow() - timedelta(minutes=30)).isoformat()
    if (lfm.get("created_at") or "") < cutoff:
        sb_patch("lfm", {"id": lfm_id}, {"status": "expired"})
        return jsonify({"error": "Announcement expired"}), 410
    cid = f"ch_{int(datetime.now().timestamp())}_{uid[:6]}"
    sb_post("challenges", {"id": cid,
        "challenger_id": lfm["player_id"], "challenger_name": lfm["player_name"],
        "challenged_id": uid, "challenged_name": session["user"]["username"],
        "status": "accepted", "format": lfm["format"], "stocks": lfm.get("stocks"),
        "from_lfm": True, "created_at": datetime.now().isoformat()})
    sb_patch("lfm", {"id": lfm_id}, {"status": "matched", "matched_with": uid})
    return jsonify({"success": True, "challenge_id": cid,
                    "format": lfm["format"], "opponent": lfm["player_name"]})

@app.route("/lfm/<lfm_id>/cancel", methods=["POST"])
def cancel_lfm(lfm_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    sb_patch("lfm", {"id": lfm_id, "player_id": session["user"]["id"]}, {"status": "cancelled"})
    return jsonify({"success": True})

if __name__ == "__main__":
    app.run(debug=True)
