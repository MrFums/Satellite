# Satellite

A live map of your raid in the browser, for SPT 4.1. Use it on a second monitor, a tablet or a phone.

![Satellite in a raid](examples/IngameExample.webp)

## Features

![Maps, quests and options](examples/FeaturesExample.webp)

- Uses top-down scans of every base game map, with modded maps as add-ons
- Shows you, your teammates and every bot live in the raid
- Shows your extracts and whether they're open, need something, or are closed, secret ones once you find their note
- Shows transits and the map each one goes to
- Shows loose loot and what's inside containers, coloured by value (uses Better Flea prices if you have it)
- Can show only the loot on your wishlist
- Writes what bots and players pick up on the map as it happens
- Shows locked doors and which key opens them
- Shows markers for your quests and their items, your Fika friends' quests too, and the loot your quests need found in raid
- Shows power switches and levers, and whether they've been switched
- Shows the floor you're on when you walk into a building
- Shows minefields, claymores and sniper zones
- Lists everyone in the raid, with a kill feed and raid events
- Shows what each bot is doing if you run SAIN, ORBIT or COMET
- Points to players and bosses off the edge of the screen
- Lets you search for loot, keys and quests
- Works on your phone (scan the code in Settings > About), in 10 languages
- Lets you turn every marker and feature on or off
- Lets you export and import your settings

It only reads. Nothing on the page changes anyone's game.

## Install

1. Close the game and the server.
2. Extract the zip into your SPT folder.
3. Start the server, then open `https://127.0.0.1:6969/satellite/`. It's also under Mod Pages in the launcher, and
   Left Alt + M opens it in game.

The browser warns about the certificate the first time. That's SPT's own. Click Advanced, then Continue.

Fika: install it on the server, every player's game and the headless if you use one. The map takes the bots, kills
and events from whoever hosts the raid, and your own position from your game. The headless never shows as a player.

## On your phone

![Satellite on a phone](examples/PhoneExample.webp)

Needs Fika on the server. Fika opens the server to your network; without it, the server only answers the PC it runs
on. The phone needs to reach that PC: on the same Wi-Fi, or through a VPN into your home network.

1. Let SPT.Server.exe through the Windows firewall on Private networks.
2. Make sure your Wi-Fi is set to Private in Windows.
3. Open the map on the PC, go to Settings > About and scan the code.

If port 6969 is forwarded for Fika, anyone with your address can open the map too.

## Controls

| | |
|---|---|
| Drag | Move the map |
| Wheel, pinch, `+` `-` | Zoom |
| `;` | Follow the player |
| `0` | Whole map |
| `M` | Menu |
| `P` | Raid list |
| `L` | Loot tab |
| `Q` | Quests tab |
| `/` | Search |
| `B` | Outline buildings |
| `[` `]` | Floor down / up |
| `F` | Full screen |
| `H` | Hide the controls |

## Settings

- Page settings are in the menu, saved in each viewer's browser.
- `SPT_Runtime/user/mods/Satellite/config.jsonc`: the server owner can turn off any kind of marker or loot for every
  page. Made on first start. Updates don't overwrite it. Restart the server after a change.
  The map's own `[Client Request]` lines are left out of the server window (other requests are logged as SPT always
  does); `"server": { "quietLogs": false }` in it brings them back.
- F12 > Fums-Satellite: the key that opens the map, and how often it updates.

## COMET replay diagnostics

In a recorded raid, choose **Debug > Bots** to open the **COMET event inspector** or **COMET raid reports**. The inspector starts with the followed bot if one is selected. Search by bot, feature, stage or reason, or choose **From playhead** to read from the current moment. Each event links back to the map.

For a full capture, enable **Extended replay data** in COMET and set `history.cometDebug` to `true` in Satellite before the raid. Restart the SPT server after changing its config. Existing recordings can show the data they already contain. Essential works with the normal replay settings.

## Build

```powershell
.\build.ps1 -SPTPath D:\SPT
```

Needs the .NET 10 SDK and an SPT 4.1 folder. Add `-Recording` for raid history, replays and the Why panel (the 1.1.0
betas are built with it), and `-NoInstall` to only build and zip. Pull requests for 1.1.0 go to `release/1.1.0-alpha`.

## Credits

- Made by Fums.
- The mod and its map scans are [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/): use, share and change
  them with credit, but don't sell them. See `LICENSE.md`.
- QR codes: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase, MIT. "QR Code"
  is a registered trademark of DENSO WAVE INCORPORATED.
- Cursors: [Cursor Pack](https://kenney.nl/assets/cursor-pack) by Kenney, CC0.
- Escape from Tarkov belongs to Battlestate Games. Satellite is a fan mod, not made or backed by them.
