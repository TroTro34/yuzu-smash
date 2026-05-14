from flask import Flask, redirect, request, session, url_for, render_template, jsonify
import requests
import os
import json
from datetime import datetime

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "yuzu_smash_secret_key_change_in_prod")

# ═══════════════════════════════════════════
# DISCORD CONFIG
# ═══════════════════════════════════════════
CLIENT_ID = "1504467669712240861"
CLIENT_SECRET = "QahsRp2-btABeiU5jBtucSlB5DAzK8oc"
GUILD_ID = "1051577844318339172"
REDIRECT_URI = os.environ.get("REDIRECT_URI", "http://localhost:5000/callback")

DISCORD_AUTH_URL = (
    f"https://discord.com/oauth2/authorize"
    f"?client_id={CLIENT_ID}"
    f"&redirect_uri={REDIRECT_URI}"
    f"&response_type=code"
    f"&scope=identify guilds"
)

# ═══════════════════════════════════════════
# DATABASE (simple JSON file)
# ═══════════════════════════════════════════
DB_FILE = "database.json"

def load_db():
    if not os.path.exists(DB_FILE):
        return {"players": {}, "matches": [], "challenges": {}}
    with open(DB_FILE, "r") as f:
        return json.load(f)

def save_db(db):
    with open(DB_FILE, "w") as f:
        json.dump(db, f, indent=2)

# ═══════════════════════════════════════════
# ELO RATING (like start.gg)
# K=32 for standard matches; adjust as needed
# ═══════════════════════════════════════════
ELO_K = 32

def calculate_elo(winner_rating, loser_rating):
    """
    Returns (new_winner_rating, new_loser_rating).
    Uses standard ELO with K=32.
    The point swing is larger when an underdog wins.
    """
    expected_win  = 1 / (1 + 10 ** ((loser_rating  - winner_rating)  / 400))
    expected_loss = 1 / (1 + 10 ** ((winner_rating - loser_rating) / 400))

    new_winner = round(winner_rating + ELO_K * (1 - expected_win))
    new_loser  = max(0, round(loser_rating  + ELO_K * (0 - expected_loss)))
    return new_winner, new_loser

def valid_score(score, fmt):
    """Validate score string against the set format (start.gg-style)."""
    try:
        parts = score.split("-")
        if len(parts) != 2:
            return False
        a, b = int(parts[0]), int(parts[1])
    except (ValueError, AttributeError):
        return False

    limits = {"BO1": 1, "BO3": 2, "BO5": 3}
    target = limits.get(fmt)
    if not target:
        return False
    winner_score = max(a, b)
    loser_score  = min(a, b)
    return winner_score == target and loser_score < target

# ═══════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════
def finalize_match(db, challenge, winner_id, loser_id, score):
    """Apply ELO, record the match, close the challenge."""
    w = db["players"][winner_id]
    l = db["players"][loser_id]

    old_w = w["points"]
    old_l = l["points"]
    new_w, new_l = calculate_elo(old_w, old_l)

    w["points"]         = new_w
    w["wins"]          += 1
    w["matches_played"] += 1

    l["points"]         = new_l
    l["losses"]        += 1
    l["matches_played"] += 1

    db["matches"].append({
        "challenge_id":  challenge["id"],
        "winner_id":     winner_id,
        "winner_name":   w["username"],
        "loser_id":      loser_id,
        "loser_name":    l["username"],
        "score":         score,
        "format":        challenge["format"],
        "elo_change":    new_w - old_w,   # positive for winner
        "date":          datetime.now().isoformat()
    })

    challenge["status"] = "completed"
    return new_w, new_l

# ═══════════════════════════════════════════
# MAIN ROUTES
# ═══════════════════════════════════════════

@app.route("/")
def index():
    db = load_db()
    user = session.get("user")
    players = sorted(db["players"].values(), key=lambda p: p["points"], reverse=True)
    recent_matches = db["matches"][-10:][::-1]
    return render_template("index.html", user=user, players=players, recent_matches=recent_matches)

@app.route("/login")
def login():
    return redirect(DISCORD_AUTH_URL)

@app.route("/callback")
def callback():
    code = request.args.get("code")
    if not code:
        return redirect(url_for("index"))

    data = {
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type":    "authorization_code",
        "code":          code,
        "redirect_uri":  REDIRECT_URI,
    }
    token_res = requests.post("https://discord.com/api/oauth2/token", data=data)
    if token_res.status_code != 200:
        return "Discord login error", 400

    token   = token_res.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    user_res  = requests.get("https://discord.com/api/users/@me",        headers=headers)
    user_data = user_res.json()

    guilds_res = requests.get("https://discord.com/api/users/@me/guilds", headers=headers)
    guilds     = guilds_res.json()
    guild_ids  = [g["id"] for g in guilds]

    if GUILD_ID not in guild_ids:
        return render_template("not_member.html")

    session["user"]  = user_data
    session["token"] = token

    db      = load_db()
    user_id = user_data["id"]
    if user_id not in db["players"]:
        db["players"][user_id] = {
            "id":             user_id,
            "username":       user_data["username"],
            "avatar":         user_data.get("avatar"),
            "points":         1000,
            "wins":           0,
            "losses":         0,
            "matches_played": 0
        }
    else:
        db["players"][user_id]["username"] = user_data["username"]
        db["players"][user_id]["avatar"]   = user_data.get("avatar")

    save_db(db)
    return redirect(url_for("dashboard"))

@app.route("/dashboard")
def dashboard():
    if not session.get("user"):
        return redirect(url_for("index"))

    db      = load_db()
    user    = session["user"]
    user_id = user["id"]
    player  = db["players"].get(user_id)
    players = sorted(db["players"].values(), key=lambda p: p["points"], reverse=True)

    rank = next((i + 1 for i, p in enumerate(players) if p["id"] == user_id), None)

    challenges = db.get("challenges", {})

    # Incoming challenges (pending)
    challenges_received = {
        k: v for k, v in challenges.items()
        if v["challenged_id"] == user_id and v["status"] == "pending"
    }

    # Active matches (accepted, awaiting result from you)
    active_matches = {
        k: v for k, v in challenges.items()
        if v["status"] == "accepted"
        and user_id in [v["challenger_id"], v["challenged_id"]]
        and v.get("reported_by") != user_id          # you haven't reported yet
    }

    # Matches waiting for your CONFIRMATION (opponent already reported)
    awaiting_confirmation = {
        k: v for k, v in challenges.items()
        if v["status"] == "reported"
        and v.get("reported_by") != user_id
        and user_id in [v["challenger_id"], v["challenged_id"]]
    }

    # Disputed matches you're involved in
    disputed = {
        k: v for k, v in challenges.items()
        if v["status"] == "disputed"
        and user_id in [v["challenger_id"], v["challenged_id"]]
    }

    # Challenges you sent that are still pending
    challenges_sent_pending = {
        k: v for k, v in challenges.items()
        if v["challenger_id"] == user_id and v["status"] == "pending"
    }

    my_matches = [
        m for m in db["matches"]
        if m["winner_id"] == user_id or m["loser_id"] == user_id
    ][-5:][::-1]

    return render_template(
        "dashboard.html",
        user=user,
        player=player,
        players=players,
        rank=rank,
        challenges_received=challenges_received,
        challenges_sent_pending=challenges_sent_pending,
        active_matches=active_matches,
        awaiting_confirmation=awaiting_confirmation,
        disputed=disputed,
        my_matches=my_matches,
    )

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))

# ═══════════════════════════════════════════
# CHALLENGE SYSTEM
# ═══════════════════════════════════════════

@app.route("/challenge/<opponent_id>", methods=["POST"])
def challenge(opponent_id):
    if not session.get("user"):
        return jsonify({"error": "Not logged in"}), 401

    db      = load_db()
    user_id = session["user"]["id"]

    if user_id == opponent_id:
        return jsonify({"error": "You cannot challenge yourself"}), 400
    if opponent_id not in db["players"]:
        return jsonify({"error": "Player not found"}), 404

    for c in db.get("challenges", {}).values():
        if c["status"] == "pending" and (
            (c["challenger_id"] == user_id and c["challenged_id"] == opponent_id) or
            (c["challenger_id"] == opponent_id and c["challenged_id"] == user_id)
        ):
            return jsonify({"error": "A challenge between you two is already pending"}), 400

    challenge_id = f"{user_id}_{opponent_id}_{int(datetime.now().timestamp())}"
    db.setdefault("challenges", {})[challenge_id] = {
        "id":              challenge_id,
        "challenger_id":   user_id,
        "challenger_name": session["user"]["username"],
        "challenged_id":   opponent_id,
        "challenged_name": db["players"][opponent_id]["username"],
        "status":          "pending",
        "format":          None,
        "created_at":      datetime.now().isoformat()
    }
    save_db(db)
    return jsonify({"success": True, "challenge_id": challenge_id})

@app.route("/challenge/<challenge_id>/accept", methods=["POST"])
def accept_challenge(challenge_id):
    if not session.get("user"):
        return jsonify({"error": "Not logged in"}), 401

    db        = load_db()
    user_id   = session["user"]["id"]
    challenge = db.get("challenges", {}).get(challenge_id)

    if not challenge or challenge["challenged_id"] != user_id:
        return jsonify({"error": "Challenge not found"}), 404

    fmt = request.json.get("format")
    if fmt not in ["BO1", "BO3", "BO5"]:
        return jsonify({"error": "Invalid format"}), 400

    challenge["status"] = "accepted"
    challenge["format"] = fmt
    save_db(db)
    return jsonify({"success": True})

@app.route("/challenge/<challenge_id>/decline", methods=["POST"])
def decline_challenge(challenge_id):
    if not session.get("user"):
        return jsonify({"error": "Not logged in"}), 401

    db        = load_db()
    user_id   = session["user"]["id"]
    challenge = db.get("challenges", {}).get(challenge_id)

    if not challenge or challenge["challenged_id"] != user_id:
        return jsonify({"error": "Challenge not found"}), 404

    challenge["status"] = "declined"
    save_db(db)
    return jsonify({"success": True})

# ═══════════════════════════════════════════
# RESULT SYSTEM  (start.gg-style dual report)
# ═══════════════════════════════════════════
# Flow:
#   1. Either player POSTs /result/<id>  → status = "reported"
#   2. The OTHER player either:
#        - confirms  → /result/<id>/confirm  → status = "completed", ELO applied
#        - disputes  → /result/<id>/dispute  → status = "disputed"  (admin review)

@app.route("/result/<challenge_id>", methods=["POST"])
def submit_result(challenge_id):
    if not session.get("user"):
        return jsonify({"error": "Not logged in"}), 401

    db        = load_db()
    user_id   = session["user"]["id"]
    challenge = db.get("challenges", {}).get(challenge_id)

    if not challenge or challenge["status"] not in ("accepted", "reported"):
        return jsonify({"error": "Invalid or already completed challenge"}), 404

    if user_id not in [challenge["challenger_id"], challenge["challenged_id"]]:
        return jsonify({"error": "You are not part of this match"}), 403

    # Prevent double-reporting by the same player
    if challenge.get("reported_by") == user_id:
        return jsonify({"error": "You already reported a result — wait for your opponent to confirm"}), 400

    data      = request.json
    winner_id = data.get("winner_id")
    score     = data.get("score", "").strip()

    if winner_id not in [challenge["challenger_id"], challenge["challenged_id"]]:
        return jsonify({"error": "Invalid winner"}), 400

    # Validate score format
    if score and not valid_score(score, challenge["format"]):
        return jsonify({"error": f"Invalid score for {challenge['format']}. "
                                 f"Expected e.g. {'1-0' if challenge['format']=='BO1' else '2-1' if challenge['format']=='BO3' else '3-2'}"}), 400

    loser_id = (challenge["challenged_id"]
                if winner_id == challenge["challenger_id"]
                else challenge["challenger_id"])

    # ── First report ──────────────────────────────────────
    if challenge["status"] == "accepted":
        challenge["status"]      = "reported"
        challenge["reported_by"] = user_id
        challenge["report"]      = {"winner_id": winner_id, "loser_id": loser_id, "score": score}
        save_db(db)
        return jsonify({"success": True, "message": "Result submitted — waiting for opponent confirmation"})

    # ── Second report: check if it matches ───────────────
    first_report = challenge["report"]
    if winner_id == first_report["winner_id"]:
        # Agreement → finalize
        agreed_score = first_report["score"] or score
        new_w, new_l = finalize_match(db, challenge, winner_id, loser_id, agreed_score)
        save_db(db)
        return jsonify({
            "success": True,
            "confirmed": True,
            "winner_points": new_w,
            "loser_points":  new_l
        })
    else:
        # Disagreement → disputed
        challenge["status"]           = "disputed"
        challenge["dispute_report"]   = {"winner_id": winner_id, "loser_id": loser_id, "score": score, "by": user_id}
        save_db(db)
        return jsonify({"success": True, "disputed": True,
                        "message": "Result disputed — an admin will review"})


@app.route("/result/<challenge_id>/confirm", methods=["POST"])
def confirm_result(challenge_id):
    """Shortcut: the second player confirms the first report without re-entering data."""
    if not session.get("user"):
        return jsonify({"error": "Not logged in"}), 401

    db        = load_db()
    user_id   = session["user"]["id"]
    challenge = db.get("challenges", {}).get(challenge_id)

    if not challenge or challenge["status"] != "reported":
        return jsonify({"error": "Nothing to confirm"}), 404

    if challenge.get("reported_by") == user_id:
        return jsonify({"error": "You already submitted this report"}), 400

    if user_id not in [challenge["challenger_id"], challenge["challenged_id"]]:
        return jsonify({"error": "You are not part of this match"}), 403

    report   = challenge["report"]
    new_w, new_l = finalize_match(db, challenge, report["winner_id"], report["loser_id"], report["score"])
    save_db(db)
    return jsonify({"success": True, "winner_points": new_w, "loser_points": new_l})


@app.route("/result/<challenge_id>/dispute", methods=["POST"])
def dispute_result(challenge_id):
    """The second player disagrees with the reported result."""
    if not session.get("user"):
        return jsonify({"error": "Not logged in"}), 401

    db        = load_db()
    user_id   = session["user"]["id"]
    challenge = db.get("challenges", {}).get(challenge_id)

    if not challenge or challenge["status"] != "reported":
        return jsonify({"error": "Nothing to dispute"}), 404

    if challenge.get("reported_by") == user_id:
        return jsonify({"error": "You already submitted this report"}), 400

    if user_id not in [challenge["challenger_id"], challenge["challenged_id"]]:
        return jsonify({"error": "You are not part of this match"}), 403

    challenge["status"]         = "disputed"
    challenge["disputed_by"]    = user_id
    challenge["disputed_at"]    = datetime.now().isoformat()
    save_db(db)
    return jsonify({"success": True, "message": "Dispute submitted — an admin will review"})


# ═══════════════════════════════════════════
# ADMIN: resolve disputed match
# ═══════════════════════════════════════════

@app.route("/admin/resolve/<challenge_id>", methods=["POST"])
def admin_resolve(challenge_id):
    """
    Simple admin endpoint (no auth yet — add a secret header or role check in prod).
    POST body: { "winner_id": "<id>", "score": "2-1" }
    """
    db        = load_db()
    challenge = db.get("challenges", {}).get(challenge_id)

    if not challenge or challenge["status"] != "disputed":
        return jsonify({"error": "Not a disputed match"}), 404

    data      = request.json
    winner_id = data.get("winner_id")
    score     = data.get("score", "")

    if winner_id not in [challenge["challenger_id"], challenge["challenged_id"]]:
        return jsonify({"error": "Invalid winner"}), 400

    loser_id = (challenge["challenged_id"]
                if winner_id == challenge["challenger_id"]
                else challenge["challenger_id"])

    new_w, new_l = finalize_match(db, challenge, winner_id, loser_id, score)
    save_db(db)
    return jsonify({"success": True, "winner_points": new_w, "loser_points": new_l})


if __name__ == "__main__":
    app.run(debug=True)
