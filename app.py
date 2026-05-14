from flask import Flask, redirect, request, session, url_for, render_template, jsonify
import requests
import os
import json
from datetime import datetime

app = Flask(__name__)
# On utilise une variable d'environnement pour la sécurité
app.secret_key = os.environ.get("SECRET_KEY", "une-phrase-tres-longue-et-secrete")

# ═══════════════════════════════════════════
# DISCORD CONFIG (Sécurisée via Variables Render)
# ═══════════════════════════════════════════
CLIENT_ID = "1504467669712240861"
# On récupère le secret depuis les paramètres Render
CLIENT_SECRET = os.environ.get("DISCORD_CLIENT_SECRET") 
GUILD_ID = "1051577844318339172"
# L'URL de redirection récupérée depuis les paramètres Render
REDIRECT_URI = os.environ.get("REDIRECT_URI", "https://yuzu-smash.onrender.com/callback")

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
        try:
            return json.load(f)
        except:
            return {"players": {}, "matches": [], "challenges": {}}

def save_db(db):
    with open(DB_FILE, "w") as f:
        json.dump(db, f, indent=4)

# ═══════════════════════════════════════════
# ELO SYSTEM
# ═══════════════════════════════════════════
ELO_K = 32

def calculate_elo(winner_rating, loser_rating):
    expected_winner = 1 / (1 + 10 ** ((loser_rating - winner_rating) / 400))
    expected_loser = 1 / (1 + 10 ** ((winner_rating - loser_rating) / 400))
    
    new_winner_rating = round(winner_rating + ELO_K * (1 - expected_winner))
    new_loser_rating = round(loser_rating + ELO_K * (0 - expected_loser))
    
    return new_winner_rating, max(0, new_loser_rating)

def finalize_match(db, challenge, winner_id, loser_id, score):
    winner = db["players"][winner_id]
    loser = db["players"][loser_id]
    
    old_w, old_l = winner["points"], loser["points"]
    new_w, new_l = calculate_elo(old_w, old_l)
    
    winner["points"] = new_w
    winner["wins"] += 1
    winner["matches_played"] += 1
    
    loser["points"] = new_l
    loser["losses"] += 1
    loser["matches_played"] += 1
    
    db["matches"].append({
        "challenge_id": challenge["id"],
        "winner_id": winner_id,
        "winner_name": winner["username"],
        "loser_id": loser_id,
        "loser_name": loser["username"],
        "score": score,
        "format": challenge["format"],
        "elo_change": new_w - old_w,
        "date": datetime.now().isoformat()
    })
    
    challenge["status"] = "completed"
    return new_w, new_l

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
    if not code: return redirect(url_for("index"))
    
    data = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    r = requests.post("https://discord.com/api/oauth2/token", data=data, headers=headers)
    
    if r.status_code != 200:
        return f"Discord Error: {r.text}", 400
    
    token = r.json().get("access_token")
    user_headers = {"Authorization": f"Bearer {token}"}
    user_data = requests.get("https://discord.com/api/users/@me", headers=user_headers).json()
    guilds = requests.get("https://discord.com/api/users/@me/guilds", headers=user_headers).json()
    
    if GUILD_ID not in [g["id"] for g in guilds]:
        return render_template("not_member.html")
    
    session["user"] = user_data
    db = load_db()
    uid = user_data["id"]
    
    if uid not in db["players"]:
        db["players"][uid] = {
            "id": uid,
            "username": user_data["username"],
            "avatar": user_data.get("avatar"),
            "points": 1000, "wins": 0, "losses": 0, "matches_played": 0
        }
    else:
        db["players"][uid]["username"] = user_data["username"]
        db["players"][uid]["avatar"] = user_data.get("avatar")
    
    save_db(db)
    return redirect(url_for("dashboard"))

@app.route("/dashboard")
def dashboard():
    if "user" not in session: return redirect(url_for("index"))
    db = load_db()
    user_id = session["user"]["id"]
    player = db["players"].get(user_id)
    players = sorted(db["players"].values(), key=lambda p: p["points"], reverse=True)
    rank = next((i+1 for i,p in enumerate(players) if p["id"] == user_id), None)
    
    all_challenges = db.get("challenges", {})
    return render_template("dashboard.html", 
        user=session["user"], player=player, players=players, rank=rank,
        challenges_received={k:v for k,v in all_challenges.items() if v["challenged_id"] == user_id and v["status"] == \"pending\"},
        active_matches={k:v for k,v in all_challenges.items() if v["status"] == \"accepted\" and user_id in [v["challenger_id"], v["challenged_id"]]},
        awaiting_confirmation={k:v for k,v in all_challenges.items() if v["status"] == \"reported\" and v.get(\"reported_by\") != user_id and user_id in [v[\"challenger_id\"], v[\"challenged_id\"]]},
        my_matches=[m for m in db["matches"] if m["winner_id"] == user_id or m["loser_id"] == user_id][-5:][::-1]
    )

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))

@app.route("/challenge/<opponent_id>", methods=["POST"])
def challenge(opponent_id):
    if "user" not in session: return jsonify({"error": "Unauthorized"}), 401
    db = load_db()
    user_id = session["user"]["id"]
    cid = f"ch_{int(datetime.now().timestamp())}_{user_id}"
    
    db.setdefault("challenges", {})[cid] = {
        "id": cid, "challenger_id": user_id, "challenger_name": session["user"]["username"],
        "challenged_id": opponent_id, "challenged_name": db["players"][opponent_id]["username"],
        "status": "pending", "format": None, "created_at": datetime.now().isoformat()
    }
    save_db(db)
    return jsonify({"success": True})

@app.route("/challenge/<challenge_id>/accept", methods=["POST"])
def accept_challenge(challenge_id):
    db = load_db()
    challenge = db.get("challenges", {}).get(challenge_id)
    if not challenge: return jsonify({"error": "Not found"}), 404
    
    data = request.json
    challenge["format"] = data.get("format", "BO3")
    challenge["status"] = "accepted"
    save_db(db)
    return jsonify({"success": True})

@app.route("/result/<challenge_id>", methods=["POST"])
def submit_result(challenge_id):
    db = load_db()
    user_id = session["user"]["id"]
    challenge = db.get("challenges", {}).get(challenge_id)
    data = request.json
    
    winner_id = data.get("winner_id")
    score = data.get("score")
    loser_id = challenge["challenged_id"] if winner_id == challenge["challenger_id"] else challenge["challenger_id"]
    
    if challenge["status"] == "accepted":
        challenge["status"] = "reported"
        challenge["reported_by"] = user_id
        challenge["report"] = {"winner_id": winner_id, "score": score}
        save_db(db)
        return jsonify({"success": True, "message": "Attente confirmation adversaire"})
    
    if challenge["status"] == "reported" and challenge["reported_by"] != user_id:
        if winner_id == challenge["report"]["winner_id"]:
            finalize_match(db, challenge, winner_id, loser_id, score)
            save_db(db)
            return jsonify({"success": True, "message": "Match validé !"})
        else:
            challenge["status"] = "disputed"
            save_db(db)
            return jsonify({"success": True, "message": "Conflit ! Un admin doit trancher."})

if __name__ == "__main__":
    app.run(debug=True)
