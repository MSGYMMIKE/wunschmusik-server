# Wunschmusik Background Server – Setup

## Was macht dieser Server?
- Erneuert den Spotify Token alle 30 Minuten automatisch
- Schreibt den Heartbeat alle 8 Sekunden
- Läuft 24/7 auf Render – unabhängig vom Browser

## Setup (einmalig, ca. 10 Minuten)

### Schritt 1 – Firebase Service Account erstellen
1. Geh auf https://console.firebase.google.com
2. Projekt **msgym-d2a85** öffnen
3. Einstellungen (Zahnrad) → **Projekteinstellungen**
4. Tab **„Dienstkonten"**
5. Klick **„Neuen privaten Schlüssel generieren"**
6. JSON-Datei herunterladen → Inhalt kopieren

### Schritt 2 – Neuen Web Service auf Render erstellen
1. https://dashboard.render.com → **New** → **Web Service**
2. GitHub Repository **MSGYMMIKE/wunschmusik-server** auswählen
   (oder: Public Git Repository → URL des Repos)
3. Einstellungen:
   - **Name:** wunschmusik-server
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free

### Schritt 3 – Environment Variable setzen
1. Im Render Dashboard → dein Service → **Environment**
2. Neue Variable hinzufügen:
   - **Key:** `FIREBASE_SERVICE_ACCOUNT`
   - **Value:** Den gesamten JSON-Inhalt aus Schritt 1 einfügen
3. **Save Changes**

### Schritt 4 – Deploy
Render deployed automatisch. Nach ~2 Minuten läuft der Server.

## Überprüfen
- https://wunschmusik-server.onrender.com → sollte `{"status":"running"}` zeigen
- Firebase Console → state/admin-heartbeat → `source: "server"` sollte sich alle 8s updaten

## Wichtig
- Der Server läuft kostenlos auf Render Free Tier
- Web Services auf Free Tier schlafen nach 15 Min Inaktivität ein
- Der `/health` Endpoint wird vom Server selbst alle 10 Min gepingt um das zu verhindern
