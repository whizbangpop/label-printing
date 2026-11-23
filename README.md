# Remote label printing: web front end + Home Assistant print agent

Two independent pieces that talk to each other without any port forwarding:

```
 Browser ──HTTPS──▶ Cloudflare Access (SSO) ──▶ Cloudflare Tunnel ──▶ label-server (Docker, site A)
                                                        ▲
 HA add-on on Pi (site B) ──outbound WSS──▶ Cloudflare Access (service token) ─┘
        │
        └─USB──▶ Brother QL-700
```

* **`label-server/`**: a Node app in Docker. Users pick a template, fill in a form, see a
  pixel-exact preview and press Print. The server renders the label to a 1-bit PNG at the
  printer's native 300 dpi and pushes it to a connected print agent.
* **`ha-addon/`**: the Home Assistant add-on **Brother QL Print Agent** (this repo doubles as a
  Home Assistant add-on repository via `repository.yaml` at the root).
  It opens an outbound WebSocket to `wss://<your host>/agent`, receives jobs and prints them with
  [`brother_ql`](https://github.com/pklaus/brother_ql) over USB.

Both sides make only **outbound** connections: `cloudflared` from site A and the agent's WebSocket
from site B. Neither router needs open ports.

### Security layers

1. **Users** reach the UI only through Cloudflare Access (your IdP, one-time PIN, etc.).
2. **The agent** gets through Access with a **service token** on a separate `/agent` Access application.
3. **The agent** must also present `AGENT_TOKEN`, a shared secret checked by the server.
4. *Optional:* the server verifies the Cloudflare Access JWT on every request (`CF_ACCESS_TEAM_DOMAIN` +
   `CF_ACCESS_AUD`), so even someone on the Docker host's LAN can't bypass Access.
5. The server container publishes no ports. Only `cloudflared` can reach it.

---

## 1. Deploy the label server (site A)

```bash
cd label-server
cp .env.example .env
openssl rand -hex 32          # paste into AGENT_TOKEN in .env
```

### Create the tunnel

Cloudflare Zero Trust → **Networks → Tunnels → Create a tunnel** (type *Cloudflared*). Copy the
token into `TUNNEL_TOKEN` in `.env`, then add a **Public hostname**:

| Subdomain / domain | Service |
| --- | --- |
| `labels.example.com` | `http://label-server:3000` |

(`label-server` is the compose service name; cloudflared runs in the same compose network.)

```bash
docker compose up -d --build
docker compose logs -f label-server
```

### Protect the UI with Access

Zero Trust → **Access → Applications → Add an application → Self-hosted**

* Domain: `labels.example.com` (no path)
* Policy: **Allow**, include the people/groups who may print (e.g. emails ending in `@yourco.com`).

### Create the agent's service token and its own Access app

1. **Access → Service credentials → Service Tokens → Create**. Name it `label-agent`. Copy the
   **Client ID** and **Client Secret** now; the secret is shown only once.
2. **Add another Self-hosted application**:
   * Domain: `labels.example.com`, **Path: `agent`**
   * Policy action: **Service Auth** (not *Allow*), include → **Service Token** → `label-agent`.

   Access matches the most specific path, so `/agent` uses this policy and everything else uses the
   user login policy. *Service Auth* is required: with *Allow* the agent gets redirected to a login page.

3. Make sure **WebSockets** are enabled for the zone (Dashboard → your domain → Network). They are on
   by default.

### Optional: verify the Access JWT inside the app

Copy the **Application Audience (AUD) tag** of *both* Access applications (Overview tab of each)
into `.env`:

```env
CF_ACCESS_TEAM_DOMAIN=yourteam            # from yourteam.cloudflareaccess.com
CF_ACCESS_AUD=<ui app AUD>,<agent app AUD>
```

`docker compose up -d` again. The log should show `Cloudflare Access JWT verification: ON`.

---

## 2. Install the print agent (site B: Raspberry Pi with Home Assistant OS)

### Printer prep (QL-700)

* **Turn Editor Lite off.** Hold the *Editor Lite* button until the green light goes out. Otherwise
  the printer appears as a USB drive and can't print raster jobs.
* Connect it to the Pi via USB and power it on.

### Add the add-on

**Option A: add this GitHub repository (recommended, easy updates)**

1. Home Assistant → **Settings → Add-ons → Add-on Store → ⋮ → Repositories** → add
   `https://github.com/whizbangpop/label-printing`
   (the repo must be public for Home Assistant to fetch it).
2. Install **Brother QL Print Agent**. Home Assistant builds it on the Pi (takes a few minutes the first time).

**Option B: local add-on**

1. Install the *Samba share* or *Advanced SSH & Web Terminal* add-on.
2. Copy the `brother_ql_agent` folder into the `/addons` share, giving you `/addons/brother_ql_agent/config.yaml`.
3. Add-on Store → ⋮ → **Check for updates**. The add-on appears under *Local add-ons*.

### Configure

| Option | Value |
| --- | --- |
| Server URL | `wss://labels.example.com/agent` |
| Agent token | Same as `AGENT_TOKEN` on the server |
| Cloudflare Access client ID | Service token Client ID (ends `.access`) |
| Cloudflare Access client secret | Service token Client Secret |
| Agent ID / Display name | e.g. `home-ql700` / `Home QL-700` |
| Printer model | `QL-700` |
| Printer address | Leave blank (auto: `usb://0x04f9:0x2042`) |

Start it and check the **Log** tab for `Connected to wss://… as 'home-ql700'` and `Printer detected: True`.
The website header then shows `Printer: <name> - ONLINE`.

You can connect several agents (different IDs) to one server. The website then shows a printer picker.

---

## 3. Templates

Templates are JSON files. Built-ins live in `label-server/templates/`. Put your own in
`label-server/data/templates/` (mounted at `/data/templates`). They're re-read on every request, so
there's no restart needed. A custom template with the same `id` as a built-in replaces it.

```jsonc
{
  "id": "cable-flag",
  "name": "Cable flag",
  "description": "Shown under the name in the UI",
  "category": "Network",               // groups templates in the sidebar
  "label": "62",                       // brother_ql media id (see below)
  "lengthMm": 50,                      // continuous tape only (or "length" in dots)
  "rotate": 90,                        // 0 | 90 | 180 | 270, design sideways for long labels
  "fields": [
    { "name": "port", "label": "Port", "type": "text", "required": true, "placeholder": "SW1-24" },
    { "name": "note", "label": "Note", "type": "textarea" },
    { "name": "date", "label": "Date", "type": "date", "default": "today" },
    { "name": "colour", "label": "Colour", "type": "select", "options": ["Blue", "Red"] },
    { "name": "urgent", "label": "Urgent", "type": "checkbox" }
  ],
  "elements": [
    { "type": "text", "x": 20, "y": 20, "w": 550, "h": 120, "text": "{{port|upper}}",
      "fontSize": 90, "minFontSize": 30, "bold": true, "align": "center", "valign": "middle" },
    { "type": "text", "x": 0, "y": 600, "w": 590, "h": 60, "text": "URGENT",
      "background": "black", "align": "center", "showIf": "urgent" },
    { "type": "qr", "x": 20, "y": 160, "size": 200, "value": "https://wiki/ports/{{port}}" },
    { "type": "barcode", "x": 20, "y": 380, "w": 550, "h": 120, "bcid": "code128", "value": "{{port}}" },
    { "type": "line", "x1": 20, "y1": 150, "x2": 570, "y2": 150, "width": 3 },
    { "type": "rect", "x": 0, "y": 0, "w": 590, "h": 696, "stroke": 4, "radius": 12 },
    { "type": "image", "x": 400, "y": 160, "w": 180, "h": 180, "src": "logo.png" }
  ]
}
```

**Coordinates** are printer dots at 300 dpi (1 mm ≈ 11.81 dots). The design canvas is:

| | width | height |
| --- | --- | --- |
| `rotate: 0` | tape width (e.g. 696 for 62 mm) | label length |
| `rotate: 90` | label length | tape width |

**Media ids and printable width in dots:** `12` 106 · `29` 306 · `38` 413 · `50` 554 · `54` 590 ·
`62` 696 (continuous); die-cut `17x54` 165×566 · `17x87` 165×956 · `23x23` 202×202 ·
`29x42` 306×425 · `29x90` 306×991 · `39x48` 425×495 · `39x90` 413×991 · `52x29` 578×271 ·
`62x29` 696×271 · `62x100` 696×1109.

**Text options:** `fontSize` (max), `minFontSize` (it shrinks to fit the box), `fit:false`,
`wrap:false`, `bold`, `italic`, `font` (any installed family; drop `.ttf` files in `data/fonts`),
`align` left/center/right, `valign` top/middle/bottom, `lineHeight`, `padding`,
`background:"black"` (white-on-black).

**Placeholders:** `{{field}}`, filters `|upper` `|lower` `|trim` `|date` (→ `23 Nov 2026`), and
built-ins `{{_date}}` `{{_time}}` `{{_datetime}}` `{{_user}}` (the signed-in email).
`showIf` / `hideIf` name a field that controls whether the element is drawn.

**Barcodes** use [bwip-js](https://github.com/metafloor/bwip-js), so any `bcid` it supports works
(`code128`, `ean13`, `datamatrix`, `code39`…). Bars are scaled by whole pixels to stay scannable.

---

## Reference

### Server environment

| Variable | Default | |
| --- | --- | --- |
| `AGENT_TOKEN` | (required) | Shared secret, at least 24 chars |
| `TUNNEL_TOKEN` | | Used by the cloudflared container |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | | Enable in-app JWT verification |
| `MAX_COPIES` | 20 | Per job |
| `JOB_TIMEOUT_MS` | 60000 | How long to wait for the printer to confirm |
| `TZ` | UTC | Affects `{{_date}}` / `{{_time}}` |
| `PORT` | 3000 | |

### HTTP API (all behind Access)

`GET /api/templates` · `GET /api/agents` · `GET /api/jobs` · `GET /api/me` ·
`POST /api/preview {templateId, fields}` → PNG ·
`POST /api/print {templateId, fields, copies, agentId?}` → job JSON (waits for the printer's confirmation).

### Agent protocol (`wss://…/agent`, JSON text frames)

| Direction | Message |
| --- | --- |
| agent → server | `{type:"hello", agentId, name, version, printer}` |
| agent → server | `{type:"status", printer:{connected,…}}` every 30 s |
| server → agent | `{type:"print", jobId, label, image:<base64 PNG>, copies, cut}` |
| agent → server | `{type:"job", jobId, status:"printing" \| "done" \| "error", error?}` |

The server pings every 25 s and the agent every 20 s, which keeps Cloudflare from dropping an idle
socket (about 100 s). The agent reconnects with exponential backoff, capped at 60 s.

### Running the agent outside Home Assistant

It's a plain Python script. Install `python3-pil python3-usb`, run `pip install brother_ql==0.9.4 websockets`,
then `SERVER_URL=… AGENT_TOKEN=… CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… python3 agent/main.py`.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| Agent log: `HTTP 302 redirect` | Service token wrong, or `/agent` app uses *Allow* instead of *Service Auth* |
| Agent log: `HTTP 401` | `agent_token` ≠ `AGENT_TOKEN` |
| Agent log: `HTTP 403` | Access denied the token, or `CF_ACCESS_AUD` lacks the agent app's AUD |
| `Printer detected: False` | Cable/power, Editor Lite still on, restart add-on after plugging in |
| Printer flashes red after a job | Loaded roll doesn't match the template's `label` |
| UI says *Timed out waiting for the printer* | Agent connected but USB write hung. Power-cycle the printer |
