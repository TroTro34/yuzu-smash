from flask import Flask, redirect, request, session, url_for, render_template, jsonify
import requests
import os
from datetime import datetime

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "yuzu_dev_secret")

# ═══════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════
CLIENT_ID = "1504467669712240861"
CLIENT_SECRET = os.environ.get("DISCORD_CLIENT_SECRET", "")
GUILD_ID = "1051577844318339172"
REDIRECT_URI = os.environ.get("REDIRECT_URI", "https://yuzu-smash.onrender.com/callback")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

DISCORD_AUTH_URL = (
    f"https://discord.com/oauth2/authorize"
    f"?client_id={CLIENT_ID}"
    f"&redirect_uri={REDIRECT_URI}"
    f"&response_type=code"
    f"&scope=identify guilds"
)

POINTS_WIN = 10
POINTS_LOSS = 10

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

def sb_delete(table, match):
    params = "&".join([f"{k}=eq.{v}" for k, v in match.items()])
    r = requests.delete(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=sb_headers())
    return r.ok

def get_last_update():
    matches = sb_get("matches", "order=id.desc&limit=1")
    challenges = sb_get("challenges", "order=created_at.desc&limit=1")
    ts = 0
    if matches:
        try:
            ts = max(ts, datetime.fromisoformat(matches[0]["date"].replace("Z","")).timestamp())
        except: pass
    if challenges:
        try:
            ts = max(ts, datetime.fromisoformat(challenges[0]["created_at"].replace("Z","")).timestamp())
        except: pass
    return ts

# ═══════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════

@app.route("/")
def index():
    user = session.get("user")
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

    uid = user_data["id"]
    existing = sb_get("players", f"id=eq.{uid}")
    if not existing:
        sb_post("players", {
            "id": uid,
            "username": user_data["username"],
            "avatar": user_data.get("avatar"),
            "points": 1000, "wins": 0, "losses": 0, "matches_played": 0
        })
    else:
        sb_patch("players", {"id": uid}, {
            "username": user_data["username"],
            "avatar": user_data.get("avatar")
        })

    return redirect(url_for("dashboard"))

@app.route("/dashboard")
def dashboard():
    if "user" not in session:
        return redirect(url_for("index"))

    user_id = session["user"]["id"]
    players = sb_get("players", "order=points.desc")
    player = next((p for p in players if p["id"] == user_id), None)
    rank = next((i + 1 for i, p in enumerate(players) if p["id"] == user_id), None)

    all_challenges = sb_get("challenges", "status=neq.completed&status=neq.declined&status=neq.disputed")

    challenges_received = [c for c in all_challenges if c["challenged_id"] == user_id and c["status"] == "pending"]
    active_matches = [c for c in all_challenges if c["status"] == "accepted" and user_id in [c["challenger_id"], c["challenged_id"]]]
    awaiting = [c for c in all_challenges if c["status"] == "reported" and c.get("reported_by") != user_id and user_id in [c["challenger_id"], c["challenged_id"]]]

    my_matches = sb_get("matches", f"or=(winner_id.eq.{user_id},loser_id.eq.{user_id})&order=id.desc&limit=5")
    last_update = get_last_update()

    return render_template("dashboard.html",
        user=session["user"], player=player, players=players, rank=rank,
        challenges_received={c["id"]: c for c in challenges_received},
        active_matches={c["id"]: c for c in active_matches},
        awaiting_confirmation={c["id"]: c for c in awaiting},
        my_matches=my_matches,
        last_update=last_update
    )

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))

# ═══════════════════════════════════════════
# API TEMPS RÉEL
# ═══════════════════════════════════════════

@app.route("/api/status")
def api_status():
    if "user" not in session:
        return jsonify({"error": "Non connecté"}), 401
    user_id = session["user"]["id"]
    all_challenges = sb_get("challenges", "status=neq.completed&status=neq.declined&status=neq.disputed")
    return jsonify({
        "last_update": get_last_update(),
        "pending": sum(1 for c in all_challenges if c["challenged_id"] == user_id and c["status"] == "pending"),
        "active": sum(1 for c in all_challenges if c["status"] == "accepted" and user_id in [c["challenger_id"], c["challenged_id"]]),
        "awaiting": sum(1 for c in all_challenges if c["status"] == "reported" and c.get("reported_by") != user_id and user_id in [c["challenger_id"], c["challenged_id"]])
    })

@app.route("/api/dashboard_data")
def api_dashboard_data():
    if "user" not in session:
        return jsonify({"error": "Non connecté"}), 401
    user_id = session["user"]["id"]
    players = sb_get("players", "order=points.desc")
    player = next((p for p in players if p["id"] == user_id), None)
    rank = next((i + 1 for i, p in enumerate(players) if p["id"] == user_id), None)
    all_challenges = sb_get("challenges", "status=neq.completed&status=neq.declined&status=neq.disputed")
    challenges_received = {c["id"]: c for c in all_challenges if c["challenged_id"] == user_id and c["status"] == "pending"}
    active_matches = {c["id"]: c for c in all_challenges if c["status"] == "accepted" and user_id in [c["challenger_id"], c["challenged_id"]]}
    awaiting = {c["id"]: c for c in all_challenges if c["status"] == "reported" and c.get("reported_by") != user_id and user_id in [c["challenger_id"], c["challenged_id"]]}
    my_matches = sb_get("matches", f"or=(winner_id.eq.{user_id},loser_id.eq.{user_id})&order=id.desc&limit=5")
    return jsonify({
        "player": player, "players": players, "rank": rank,
        "challenges_received": challenges_received,
        "active_matches": active_matches,
        "awaiting_confirmation": awaiting,
        "my_matches": my_matches,
        "last_update": get_last_update()
    })

# ═══════════════════════════════════════════
# DÉFIS
# ═══════════════════════════════════════════

@app.route("/challenge/<opponent_id>", methods=["POST"])
def challenge(opponent_id):
    if "user" not in session:
        return jsonify({"error": "Non connecté"}), 401
    user_id = session["user"]["id"]
    if user_id == opponent_id:
        return jsonify({"error": "Tu ne peux pas te défier toi-même"}), 400

    opponent = sb_get("players", f"id=eq.{opponent_id}")
    if not opponent:
        return jsonify({"error": "Joueur introuvable"}), 404

    existing = sb_get("challenges", f"status=in.(pending,accepted)&or=(and(challenger_id.eq.{user_id},challenged_id.eq.{opponent_id}),and(challenger_id.eq.{opponent_id},challenged_id.eq.{user_id}))")
    if existing:
        return jsonify({"error": "Un défi est déjà en cours entre vous"}), 400

    cid = f"ch_{int(datetime.now().timestamp())}_{user_id}"
    sb_post("challenges", {
        "id": cid,
        "challenger_id": user_id,
        "challenger_name": session["user"]["username"],
        "challenged_id": opponent_id,
        "challenged_name": opponent[0]["username"],
        "status": "pending",
        "format": None
    })
    return jsonify({"success": True})

@app.route("/challenge/<challenge_id>/accept", methods=["POST"])
def accept_challenge(challenge_id):
    if "user" not in session:
        return jsonify({"error": "Non connecté"}), 401
    fmt = request.json.get("format", "BO3")
    if fmt not in ["BO1", "BO3", "BO5"]:
        return jsonify({"error": "Format invalide"}), 400
    sb_patch("challenges", {"id": challenge_id}, {"status": "accepted", "format": fmt})
    return jsonify({"success": True})

@app.route("/challenge/<challenge_id>/decline", methods=["POST"])
def decline_challenge(challenge_id):
    if "user" not in session:
        return jsonify({"error": "Non connecté"}), 401
    sb_patch("challenges", {"id": challenge_id}, {"status": "declined"})
    return jsonify({"success": True})

# ═══════════════════════════════════════════
# RÉSULTATS
# ═══════════════════════════════════════════

@app.route("/result/<challenge_id>", methods=["POST"])
def submit_result(challenge_id):
    if "user" not in session:
        return jsonify({"error": "Non connecté"}), 401

    user_id = session["user"]["id"]
    challenges = sb_get("challenges", f"id=eq.{challenge_id}")
    if not challenges:
        return jsonify({"error": "Défi introuvable"}), 404

    c = challenges[0]
    if user_id not in [c["challenger_id"], c["challenged_id"]]:
        return jsonify({"error": "Tu ne fais pas partie de ce match"}), 403

    data = request.json
    winner_id = data.get("winner_id")
    score = data.get("score", "")

    if winner_id not in [c["challenger_id"], c["challenged_id"]]:
        return jsonify({"error": "Gagnant invalide"}), 400

    loser_id = c["challenged_id"] if winner_id == c["challenger_id"] else c["challenger_id"]

    if c["status"] == "accepted":
        sb_patch("challenges", {"id": challenge_id}, {
            "status": "reported",
            "reported_by": user_id,
            "report": {"winner_id": winner_id, "score": score}
        })
        return jsonify({"success": True, "message": "Résultat soumis ! En attente de confirmation de l'adversaire."})

    if c["status"] == "reported" and c.get("reported_by") != user_id:
        report = c.get("report") or {}
        if winner_id == report.get("winner_id"):
            # Mettre à jour les points du gagnant
            winner = sb_get("players", f"id=eq.{winner_id}")
            loser = sb_get("players", f"id=eq.{loser_id}")
            if winner and loser:
                sb_patch("players", {"id": winner_id}, {
                    "points": winner[0]["points"] + POINTS_WIN,
                    "wins": winner[0]["wins"] + 1,
                    "matches_played": winner[0]["matches_played"] + 1
                })
                sb_patch("players", {"id": loser_id}, {
                    "points": max(0, loser[0]["points"] - POINTS_LOSS),
                    "losses": loser[0]["losses"] + 1,
                    "matches_played": loser[0]["matches_played"] + 1
                })
                sb_post("matches", {
                    "challenge_id": challenge_id,
                    "winner_id": winner_id,
                    "winner_name": winner[0]["username"],
                    "loser_id": loser_id,
                    "loser_name": loser[0]["username"],
                    "score": score,
                    "format": c["format"],
                    "date": datetime.now().isoformat()
                })
                sb_patch("challenges", {"id": challenge_id}, {"status": "completed"})
                return jsonify({"success": True, "message": "Match validé ! Points mis à jour."})
        else:
            sb_patch("challenges", {"id": challenge_id}, {"status": "disputed"})
            return jsonify({"success": True, "message": "Conflit détecté ! Contactez un admin."})

    return jsonify({"error": "Action invalide"}), 400

if __name__ == "__main__":
    app.run(debug=True)
