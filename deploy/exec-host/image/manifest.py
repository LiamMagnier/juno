"""Print what this sandbox image can run, as one JSON object on stdout.

juno-exec runs this once per image (as an ordinary sandboxed run) and serves the
result at GET /v1/manifest. The web side puts the runtimes and the package list
into run_code's description and into the hint added to a ModuleNotFoundError,
so the model is told what exists instead of guessing.
"""
import importlib.metadata
import json
import platform
import subprocess


def version(argv):
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=10).stdout.strip().splitlines()[0]
    except Exception:
        return None


packages = sorted(
    {(dist.metadata["Name"] or "").lower(): dist.version for dist in importlib.metadata.distributions() if dist.metadata["Name"]}.items()
)
print(json.dumps({
    "image": "juno-exec",
    "runtimes": {
        "python": platform.python_version(),
        "javascript": (version(["node", "--version"]) or "").lstrip("v") or None,
        "bash": version(["bash", "-c", "echo $BASH_VERSION"]),
    },
    "pythonPackages": [{"name": name, "version": value} for name, value in packages],
    "network": "none",
}))
