from flask import Flask, redirect, request, session, url_for, render_template, jsonify
import requests
import os
import json
from datetime import datetime

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "yuzu_dev_secret")

# ═══════════════════════════════════════════
# CONFIG (variables d'environnement Render)
# ═══════════════════════════════════════════
CLIENT_ID = "1504467669712240861"
CLIENT_SECRET = os.environ.get("DISCORD_CLIENT_SECRET", "")
GUILD_ID = "1051577844318339172"
REDIRECT_URI = os.environ.get("REDIRECT_URI", "https://yuzu-smash.onrender.com/callback")

DISCORD_AUTH_URL = (
    f"https://discord.com/oauth2/authorize"
    f"?client_id={CLIENT_ID}"
    f"&redirect_uri={REDIRECT_URI}"
    f"&response_type=code"
    f"&scope=identify guilds"
)

# ═══════════════════════════════════════════
# BASE DE DONNÉES JSON
# ═══════════════════════════════════════════
DB_FILE = "database.json"

def load_db():
    if not os.path.exists(DB_FILE):
        return {"players": {}, "matches": [], "challenges": {}}
    with open(DB_FILE, "r") as f:
        try:
            return json.load(f)
        except Exception:
            return {"players": {}, "matches": [], "challenges": {}}

def save_db(db):
    with open(DB_FILE, "w") as f:
        json.dump(db, f, indent=4)

# ═══════════════════════════════════════════
# SYSTÈME DE POINTS
# ═══════════════════════════════════════════
POINTS_WIN = 10
POINTS_LOSS = 10

# ═══════════════════════════════════════════
# ROUTES
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
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI
    }
    r = requests.post(
        "https://discord.com/api/oauth2/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    )

    if r.status_code != 200:
        return f"Erreur Discord : {r.text}", 400

    token = r.json().get("access_token")
    headers = {"Authorization": f"Bearer {token}"}

    user_data = requests.get("https://discord.com/api/users/@me", headers=headers).json()
    guilds = requests.get("https://discord.com/api/users/@me/guilds", headers=headers).json()

    if GUILD_ID not in [g["id"] for g in guilds]:
        return render_template("not_member.html")

    session["user"] = {
        "id": user_data["id"],
        "username": user_data["username"],
        "avatar": user_data.get("avatar")
    }

    db = load_db()
    uid = user_data["id"]
    if uid not in db["players"]:
        db["players"][uid] = {
            "id": uid,
            "username": user_data["username"],
            "avatar": user_data.get("avatar"),
            "points": 1000,
            "wins": 0,
            "losses": 0,
            "matches_played": 0
        }
    else:
        db["players"][uid]["username"] = user_data["username"]
        db["players"][uid]["avatar"] = user_data.get("avatar")

    save_db(db)
    return redirect(url_for("dashboard"))

@app.route("/dashboard")
def dashboard():
    if "user" not in session:
        return redirect(url_for("index"))

    db = load_db()
    user_id = session["user"]["id"]
    player = db["players"].get(user_id)
    players = sorted(db["players"].values(), key=lambda p: p["points"], reverse=True)
    rank = next((i + 1 for i, p in enumerate(players) if p["id"] == user_id), None)

    all_challenges = db.get("challenges", {})

    challenges_received = {
        k: v for k, v in all_challenges.items()
        if v["challenged_id"] == user_id and v["status"] == "pending"
    }
    active_matches = {
        k: v for k, v in all_challenges.items()
        if v["status"] == "accepted" and user_id in [v["challenger_id"], v["challenged_id"]]
    }
    awaiting_confirmation = {
        k: v for k, v in all_challenges.items()
        if v["status"] == "reported"
        and v.get("reported_by") != user_id
        and user_id in [v["challenger_id"], v["challenged_id"]]
    }
    my_matches = [
        m for m in db["matches"]
        if m["winner_id"] == user_id or m["loser_id"] == user_id
    ][-5:][::-1]

    return render_template("dashboard.html",
        user=session["user"],
        player=player,
        players=players,
        rank=rank,
        challenges_received=challenges_received,
        active_matches=active_matches,
        awaiting_confirmation=awaiting_confirmation,
        my_matches=my_matches
    )

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))

@app.route("/challenge/<opponent_id>", methods=["POST"])
def challenge(opponent_id):
    if "user" not in session:
        return jsonify({"error": "Non connecté"}), 401

    db = load_db()
    user_id = session["user"]["id"]

    if user_id == opponent_id:
        return jsonify({"error": "Tu ne peux pas te défier toi-même"}), 400

    if opponent_id not in db["players"]:
        return jsonify({"error": "Joueur introuvable"}), 404

    for c in db.get("challenges", {}).values():
        if c["status"] in ["pending", "accepted"] and set([c["challenger_id"], c["challenged_id"]]) == set([user_id, opponent_id]):
            return jsonify({"error": "Un défi est déjà en cours entre vous"}), 400

    cid = f"ch_{int(datetime.now().timestamp())}_{user_id}"
    db.setdefault("challenges", {})[cid] = {
        "id": cid,
        "challenger_id": user_id,
        "challenger_name": session["user"]["username"],
        "challenged_id": opponent_id,
        "challenged_name": db["players"][opponent_id]["username"],
        "status": "pending",
        "format": None,
        "created_at": datetime.now().isoformat()
    }
    save_db(db)
    return jsonify({"success": True})

@app.route("/challenge/<challenge_id>/accept", methods=["POST"])
def accept_challenge(challenge_id):
    if "user" not in session:
        return jsonify({"error": "Non connecté"}), 401

    db = load_db()
    challenge = db.get("challenges", {}).get(challenge_id)
    if not challenge:
        return jsonify({"error": "Défi introuvable"}), 404

    fmt = request.json.get("format", "BO3")
    if fmt not in ["BO1", "BO3", "BO5"]:
        return jsonify({"error": "Format invalide"}), 400

    challenge["format"] = fmt
    challenge["status"] = "accepted"
    save_db(db)
    return jsonify({"success": True})

@app.route("/challenge/<challenge_id>/decline", methods=["POST"])
def decline_challenge(challenge_id):
    if "user" not in session:
        return jsonify({"error": "Non connecté"}), 401

    db = load_db()
    challenge = db.get("challenges", {}).get(challenge_id)
    if not challenge:
        return jsonify({"error": "Défi introuvable"}), 404

    challenge["status"] = "declined"
    save_db(db)
    return jsonify({"success": True})

@app.route("/result/<challenge_id>", methods=["POST"])
def submit_result(challenge_id):
    if "user" not in session:
        return jsonify({"error": "Non connecté"}), 401

    db = load_db()
    user_id = session["user"]["id"]
    challenge = db.get("challenges", {}).get(challenge_id)

    if not challenge:
        return jsonify({"error": "Défi introuvable"}), 404

    if user_id not in [challenge["challenger_id"], challenge["challenged_id"]]:
        return jsonify({"error": "Tu ne fais pas partie de ce match"}), 403

    data = request.json
    winner_id = data.get("winner_id")
    score = data.get("score", "")

    if winner_id not in [challenge["challenger_id"], challenge["challenged_id"]]:
        return jsonify({"error": "Gagnant invalide"}), 400

    loser_id = challenge["challenged_id"] if winner_id == challenge["challenger_id"] else challenge["challenger_id"]

    if challenge["status"] == "accepted":
        challenge["status"] = "reported"
        challenge["reported_by"] = user_id
        challenge["report"] = {"winner_id": winner_id, "score": score}
        save_db(db)
        return jsonify({"success": True, "message": "Résultat soumis ! En attente de confirmation de l'adversaire."})

    if challenge["status"] == "reported" and challenge.get("reported_by") != user_id:
        if winner_id == challenge["report"]["winner_id"]:
            db["players"][winner_id]["points"] += POINTS_WIN
            db["players"][winner_id]["wins"] += 1
            db["players"][winner_id]["matches_played"] += 1
            db["players"][loser_id]["points"] = max(0, db["players"][loser_id]["points"] - POINTS_LOSS)
            db["players"][loser_id]["losses"] += 1
            db["players"][loser_id]["matches_played"] += 1

            db["matches"].append({
                "challenge_id": challenge_id,
                "winner_id": winner_id,
                "winner_name": db["players"][winner_id]["username"],
                "loser_id": loser_id,
                "loser_name": db["players"][loser_id]["username"],
                "score": score,
                "format": challenge["format"],
                "date": datetime.now().isoformat()
            })
            challenge["status"] = "completed"
            save_db(db)
            return jsonify({"success": True, "message": "Match validé ! Points mis à jour."})
        else:
            challenge["status"] = "disputed"
            save_db(db)
            return jsonify({"success": True, "message": "Conflit détecté ! Contactez un admin."})

    return jsonify({"error": "Action invalide"}), 400

if __name__ == "__main__":
    app.run(debug=True)
