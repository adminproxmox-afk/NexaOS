"""Install the exact local browser dependencies for NexaOS."""

from hashlib import sha256
from io import BytesIO
from pathlib import Path
from tarfile import open as open_tar
from urllib.request import urlopen

ASSETS = Path(__file__).resolve().parents[1] / "assets"
REGISTRY = "https://registry.npmjs.org"
BIOS = "https://raw.githubusercontent.com/copy/v86/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/bios"

ARCHIVES = (
    (
        f"{REGISTRY}/v86/-/v86-0.5.473.tgz",
        "364ab67a68c1d83646e2ddf7caf73c24574694a132b2b43689ad0f72e7242636",
        {
            "package/build/libv86.js": "libv86.js",
            "package/build/v86.wasm": "v86.wasm",
            "package/LICENSE": "v86.LICENSE.txt",
        },
    ),
    (
        f"{REGISTRY}/@xterm/xterm/-/xterm-6.0.0.tgz",
        "908e66e04af6c8dc6b00dd3b54de088e2e81e5ed866284fd6c2fb3c2d1c7a3f6",
        {
            "package/lib/xterm.js": "xterm.js",
            "package/css/xterm.css": "xterm.css",
            "package/LICENSE": "xterm.LICENSE.txt",
        },
    ),
    (
        f"{REGISTRY}/@xterm/addon-fit/-/addon-fit-0.11.0.tgz",
        "26003b4517a132b64e4ff228fd88a5fda3fff5e606c76093f6dcff772e9ecec0",
        {
            "package/lib/addon-fit.js": "xterm-fit.js",
            "package/LICENSE": "xterm-fit.LICENSE.txt",
        },
    ),
)
FILES = (
    (f"{BIOS}/seabios.bin", "73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98", "seabios.bin"),
    (f"{BIOS}/vgabios.bin", "a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880", "vgabios.bin"),
    ("https://i.copy.sh/linux.iso", "ff21a908573cdf2cf0cd00fe30eab8646b2f64874afbb34ff6de5a915eaebcdf", "linux.iso"),
)


def download(url, digest):
    print(f"Downloading {url}", flush=True)
    with urlopen(url, timeout=60) as response:
        data = response.read()
    if sha256(data).hexdigest() != digest:
        raise ValueError(f"SHA-256 mismatch for {url}")
    return data


def install(name, data):
    target = ASSETS / name
    temporary = target.with_suffix(target.suffix + ".part")
    temporary.write_bytes(data)
    temporary.replace(target)


def main():
    ASSETS.mkdir(exist_ok=True)
    for url, digest, files in ARCHIVES:
        with open_tar(fileobj=BytesIO(download(url, digest)), mode="r:gz") as archive:
            for member, name in files.items():
                with archive.extractfile(member) as source:
                    install(name, source.read())
    for url, digest, name in FILES:
        target = ASSETS / name
        if not target.is_file() or sha256(target.read_bytes()).hexdigest() != digest:
            install(name, download(url, digest))
    print("Setup complete. Run scripts/run-dev.sh or py -3 -m http.server 8000 --bind 127.0.0.1")


if __name__ == "__main__":
    main()
