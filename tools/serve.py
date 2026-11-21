"""Lokaler Testserver für die App (http://localhost:8123/?demo).

Pythons http.server übernimmt unter Windows die MIME-Typen aus der Registry und liefert
.js dann oft als text/plain aus – daran scheitert der Service Worker. Hier fest eingestellt.
"""
import http.server
import mimetypes
import pathlib

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/svg+xml", ".svg")

APP_DIR = pathlib.Path(__file__).resolve().parent.parent / "app"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)


if __name__ == "__main__":
    print("App unter http://localhost:8123/?demo")
    http.server.ThreadingHTTPServer(("localhost", 8123), Handler).serve_forever()
