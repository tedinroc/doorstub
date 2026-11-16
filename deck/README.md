# Doorstub deck
The short presentation for BCH BLAZE 2026 that the site's BLAZE banner links to, laid out on the seven slides of the official Widget Factory template.
Rebuild with `npm run deck` (offline; needs Google Chrome in /Applications and python3 with pypdf): it prints `deck/deck.html` to `app/public/deck.pdf`, then sets the title and author.
The build checks fonts, pictures, minimum text sizes, links and the code card against `contracts/Escrow.cash`, and saves a PNG of every page to `.cache/deck/png/`.
Fonts are OFL (`fonts/OFL.txt`; Barlow Condensed comes from `app/public/fonts/`); `img/` holds the site's icon and plain crops of its own e2e screenshots.
