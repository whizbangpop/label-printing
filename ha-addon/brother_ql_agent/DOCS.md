# Brother QL Print Agent

This add-on connects **out** to your label server and prints whatever it is sent on a
Brother QL printer plugged into this Home Assistant machine by USB. Nothing needs to be
opened on your router.

## Before you start

1. **Turn off Editor Lite on the QL-700.** If the green *Editor Lite* light is on, the printer
   shows up as a USB drive instead of a printer. Hold the Editor Lite button until the light goes out.
2. Plug the printer into the Pi and switch it on.
3. Load the roll that matches the template you will print (e.g. DK-22205 for 62 mm continuous).

## Configuration

| Option | What to enter |
| --- | --- |
| Server URL | `wss://<your label site>/agent` |
| Agent token | The `AGENT_TOKEN` value from the server's `.env` |
| Cloudflare Access client ID / secret | The service token you created for the agent |
| Agent ID / Display name | Anything; shows up in the website's printer list |
| Printer model | `QL-700` |
| Printer address | Leave empty for USB auto-detect |

Start the add-on and open the **Log** tab. You should see `Connected to wss://… as '…'` and
`Printer detected: True`. Within a few seconds the website header shows `Printer: <name> - ONLINE`.

## Troubleshooting

- **`HTTP 302 redirect`** – Cloudflare Access is asking for a login. The service token is wrong,
  or the `/agent` Access application uses an *Allow* policy instead of *Service Auth*.
- **`HTTP 401`** – the agent token doesn't match the server.
- **`Printer detected: False`** – check the USB cable, power, and that Editor Lite is off.
  Restart the add-on after plugging the printer in.
- **Job fails with a media error** – the loaded roll doesn't match the template's label size.
