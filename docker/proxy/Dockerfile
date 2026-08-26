# syntax=docker/dockerfile:1

# Forwards a published port to the loopback-only `dsh web` server. `dsh web`
# intentionally refuses `--host 0.0.0.0`, so this sidecar joins the web
# service's network namespace (`network_mode: "service:web"` in compose) and
# relays traffic to 127.0.0.1 from inside that namespace.

FROM alpine:3.20

RUN apk add --no-cache socat

ENTRYPOINT ["socat"]
CMD ["TCP-LISTEN:8080,fork,reuseaddr", "TCP:127.0.0.1:3080"]
