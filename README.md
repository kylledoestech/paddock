# Orca

A phone and browser client for [herdr](https://github.com/herdrdev/herdr). See which agents are blocked, answer them, open any pane at a size you can read, and get a notification when work is done.

Website: https://kylledoestech.github.io/orca/

## What it does

- **Needs you, first:** blocked and finished agents from every machine at the top of one list.
- **Live terminal:** takes over a pane at your phone's size, with pinch zoom and a control bar (esc, tab, arrows, enter, Claude mode).
- **Push notifications:** when an agent asks for input, finishes or exits. Tapping one opens that pane.
- **Hold to talk:** speech to text with Whisper large-v3 (Groq). It never sends on its own.
- **Images both ways:** upload from your phone, and view images from the Claude session.
- **Every machine:** local and SSH machines from `herdr machine list`, reached through SSH tunnels.
- **Manage:** create, rename and close spaces, tabs, panes, agents, terminals and worktrees.
- **Desktop layout:** a sidebar with the pane beside it, at 1024px and wider.

## Setup

Needs Node 22.18 or newer and herdr on the same machine.

```sh
git clone https://github.com/kylledoestech/orca
cd orca/web && npm install && npm run build
cd ../bridge && npm install
npm start    # listens on 127.0.0.1:4280
```

Put it on your tailnet, then open the address on your phone and add it to the home screen:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4280
```

Optional: put a Groq API key in `~/.config/orca/groq.key` (mode 600) to turn on voice input.

## Security

The bridge listens on localhost only and rejects requests from other origins. There is no login yet: every device on your tailnet can open it. Only use it on a tailnet you trust.

## Layout

- `bridge/`: Node server that talks to herdr's socket API and serves the web app.
- `web/`: the PWA (Vite, Preact, xterm.js).
- `site/`: the landing page, deployed to GitHub Pages.
- `docs/`: research notes.

## License

MIT
