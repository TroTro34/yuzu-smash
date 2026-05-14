# ⚔ Smash YUZU — Système de Classement

## Structure du projet
```
yuzu-smash/
├── app.py               ← Le site Flask
├── requirements.txt     ← Les librairies Python
├── render.yaml          ← Config pour déploiement
├── database.json        ← Créé automatiquement au 1er lancement
└── templates/
    ├── index.html       ← Page d'accueil + classement
    ├── dashboard.html   ← Dashboard joueur
    └── not_member.html  ← Page si pas dans le serveur
```

## Lancer en local (pour tester)

```bash
pip install flask requests gunicorn
python app.py
```
Puis ouvre http://localhost:5000

## Mettre en ligne sur Render (gratuit, 24h/24)

1. Crée un compte sur https://github.com et upload ce dossier
2. Crée un compte sur https://render.com
3. New → Web Service → connecte ton GitHub
4. Render détecte Python automatiquement → Deploy
5. Récupère ton URL (ex: https://yuzu-smash.onrender.com)
6. Dans app.py, remplace REDIRECT_URI par ton URL + /callback
7. Dans Discord Developer Portal, ajoute cette URL dans les Redirects

## Anti-veille (UptimeRobot)
- Compte gratuit sur https://uptimerobot.com
- New Monitor → HTTP → ton URL Render
- Intervalle : 5 minutes
