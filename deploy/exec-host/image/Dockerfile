# juno-exec sandbox image: the container every run_code call executes in.
#
# One container per run, started by juno-exec through the root broker with
# --network none, a read-only root, every capability dropped, no-new-privileges,
# a non-root uid, bounded memory/CPU/pids and a tmpfs /tmp (broker policy:
# exec-broker-policy.json). Mounts, all bind mounts of the session's own host
# directories: /work (the session workspace, read-write), /work/inputs (the
# conversation's files, read-only), /juno/program (this run's program, read-only)
# and /skills/<slug> (skill bundles, read-only). The mountpoints exist in the image
# because the root filesystem is read-only.
#
# Bases are pinned by digest (multi-arch index digests, so the same file builds
# linux/amd64 on the execution host and linux/arm64 on a developer's Mac).
# Python libraries are exact versions, wheels only. There is no package manager
# usable at run time: pip is removed, there is no network, and the user is not
# root. Rebuild and re-pin with setup.sh, which writes the built image id into
# the broker policy; the broker refuses every other image.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS node

FROM python:3.12-slim-bookworm@sha256:bc01d00b6417e4b1b01c331db3a14054b4be954e571ef8bf5748aaf64b66e941

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Node 22, the binary only: no npm or npx, so nothing can be fetched or installed.
COPY --from=node /usr/local/bin/node /usr/local/bin/node

COPY requirements.txt /opt/juno/requirements.txt
RUN python -m pip install --only-binary=:all: --no-deps --no-compile -r /opt/juno/requirements.txt \
 && python -m pip check \
 && python -m pip uninstall -y pip \
 && rm -rf /root/.cache \
 && useradd --uid 1000 --user-group --no-create-home --home-dir /work --shell /bin/bash sandbox \
 && mkdir -p /work/inputs /skills /juno/program \
 && chown 1000:1000 /work \
 && chmod 0555 /skills /juno /juno/program

COPY manifest.py /opt/juno/manifest.py
RUN chmod 0444 /opt/juno/manifest.py /opt/juno/requirements.txt \
 && node --version && bash --version | head -1 \
 && python -c "import pandas, numpy, scipy, matplotlib, seaborn, openpyxl, xlsxwriter, docx, pptx, pypdf, pdfplumber, PIL, reportlab"

# Matplotlib and friends write caches under HOME; the root is read-only, so HOME
# is the per-run tmpfs. Agg: there is no display.
ENV HOME=/tmp \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/.matplotlib \
    XDG_CACHE_HOME=/tmp/.cache

LABEL juno.security="exec-v1"
USER 1000:1000
WORKDIR /work
