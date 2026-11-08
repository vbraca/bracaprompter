# BracaPrompter

A teleprompter you control from your phone.

**Use it:** https://vbraca.github.io/bracaprompter/

1. Open the site on the computer next to your camera and paste your script.
2. Scan the QR code with your phone.
3. Click **Open prompter**. Everything else works from the phone: tap to play or pause, drag to move the text, tap any line to jump to it, change the speed, switch scripts.

Scripts are saved in the computer's browser only. The phone connects directly to the computer's page over WebRTC; the free [PeerJS](https://peerjs.com) server only introduces the two (and relays the encrypted traffic when a direct route isn't possible).

In a script, `[square brackets]` are notes to yourself, `*stars*` add emphasis, and a blank line starts a new paragraph.

Plain HTML, CSS and JavaScript. No build step.
