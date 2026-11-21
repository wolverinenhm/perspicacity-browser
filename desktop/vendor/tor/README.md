The Windows release workflow downloads the official Tor Expert Bundle into this folder
(`tor/tor.exe`, `tor/pluggable_transports/`, `data/geoip*`) before packaging, and the
installer ships it under `resources/tor`. Nothing here is committed except this note.

For local development you can either unpack an Expert Bundle here, set
`PERSPICACITY_TOR=/path/to/tor`, have `tor` on your PATH, or run Tor Browser
(Perspicacity uses its SOCKS port 9150 automatically).
