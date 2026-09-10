.DEFAULT_GOAL := help

.PHONY: help install build clean typecheck lint test test-coverage hygiene \
	docker-build docker-web docker-headless docker-down docker-logs \
	docker-raven docker-infra docker-infra-down docker-certs docker-certs-trust \
	docker-patch-plugins docker-check-plugins \
	docker-omni docker-omni-down docker-omni-web docker-omni-headless \
	docker-omni-key docker-omni-check docker-all docker-all-omni docker-all-down docker-discord

# The compose file set every bare `docker compose` below runs against. Overlay
# modes extend the base rather than replacing it, and compose reads COMPOSE_FILE
# from the environment, so exporting it here reaches the invocations nested in
# shell loops too. Setting it explicitly replaces compose's implicit
# docker-compose.override.yml discovery, which this repo does not use.
#
# Mode is a property of one make invocation. To point a target that has no
# overlay variant of its own at a running overlay mode, pass the set in:
#   COMPOSE_FILE=docker-compose.yml:docker-compose.omni-wire.yml make docker-patch-plugins
# The separate-project files (infra, omni) keep their own -f flags, which take
# precedence over COMPOSE_FILE.
COMPOSE_PATH_SEPARATOR := :
export COMPOSE_PATH_SEPARATOR
COMPOSE_FILE ?= docker-compose.yml
export COMPOSE_FILE

OMNI_COMPOSE_FILE := docker-compose.yml:docker-compose.omni-wire.yml
RAVEN_COMPOSE_FILE := docker-compose.yml:docker-compose.raven.yml

# Both overlays at once, for docker-all-omni. They are orthogonal: raven
# contributes the Traefik labels, trusted hosts, and HTTPS routes, omni-wire the
# gateway base URL and key. Compose normalizes a service's `networks` list into a
# map before merging, so the two lists union rather than replace, and web and api
# join default, hybrid_public, and omniroute together. raven precedes omni-wire
# because the later file wins a scalar conflict, and only omni-wire sets
# environment values that must survive.
ALL_COMPOSE_FILE := docker-compose.yml:docker-compose.raven.yml:docker-compose.omni-wire.yml

# Compose services whose dsh profile may carry a patched dsh-llm-local-token.
# Each service boots the profile of the same name.
PATCHED_SERVICES ?= web api
PLUGIN_LIB = node_modules/dsh-llm-local-token/lib

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install workspace dependencies
	pnpm install

build: ## Build the dsh CLI and web frontend
	pnpm run build

clean: ## Remove build outputs and safe residue
	pnpm run clean

typecheck: ## Type-check the workspace
	pnpm run typecheck

lint: ## Lint the workspace
	pnpm run lint

test: ## Run unit tests
	pnpm run test

test-coverage: ## Run unit tests with the CI coverage gate
	pnpm run test:coverage

hygiene: ## Run knip/publint/workspace-constraint checks
	pnpm run hygiene

docker-build: ## Build the dsh CLI image
	docker compose build

docker-web: ## Run dsh web via docker compose (http://localhost:3080)
	docker compose up web web-proxy

docker-raven: COMPOSE_FILE := $(RAVEN_COMPOSE_FILE)
docker-raven: ## Run web + API behind RavenStack's Traefik (harness.local.raven.com, harness-api.local.raven.com)
	docker compose up web web-proxy api api-proxy

docker-discord: ## Start the Discord bridge beside an already running api service (needs secrets/discord-token and DISCORD_ALLOWED_USER_IDS)
	docker compose --profile discord up -d --no-deps discord-bot

docker-certs: ## Mint the local CA and TLS certificate the HTTPS routes present
	./docker/certs/generate.sh

docker-certs-trust: ## Add the local CA to this user's Chrome/Firefox NSS store (no sudo; needs certutil)
	@command -v certutil >/dev/null 2>&1 || { \
		echo "certutil not found: install it first (Debian/Ubuntu: sudo apt-get install -y libnss3-tools)"; exit 1; }
	@test -f certs/ca.crt || { echo "certs/ca.crt missing: run 'make docker-certs' first"; exit 1; }
	certutil -d sql:$$HOME/.pki/nssdb -A -t "C,," -n "DeepSeek Harness local CA" -i certs/ca.crt
	@echo "trusted; restart the browser for it to take effect"

docker-infra: ## Run the standalone Traefik + hybrid_public_network stand-in for RavenStack's infra
	docker compose -f docker-compose.infra.yml up -d

docker-infra-down: ## Remove the standalone infra Traefik and its network (stop the raven services and the gateway first)
	docker compose -f docker-compose.infra.yml down

# Traefik first: docker-compose.omni.yml consumes hybrid_public_network as
# external for its router labels, so the gateway cannot start without it. The
# infra target is `up -d` and idempotent, so this reconciles an already-running
# Traefik rather than restarting one.
docker-omni: ## Run the OmniRoute gateway behind Traefik, detached (http://localhost:20128, omni.localhost)
	@$(MAKE) --no-print-directory docker-infra
	docker compose -f docker-compose.omni.yml up -d

docker-omni-down: ## Remove the OmniRoute gateway and omniroute_network (stop wired services first)
	docker compose -f docker-compose.omni.yml down

docker-omni-web docker-omni-headless docker-omni-check: COMPOSE_FILE := $(OMNI_COMPOSE_FILE)

docker-omni-web: ## Run web + API routed through OmniRoute (run 'make docker-omni' first)
	docker compose up web web-proxy api api-proxy

docker-omni-headless: ## Run a headless dsh task through OmniRoute; usage: make docker-omni-headless ARGS="..."
	docker compose run --rm headless $(ARGS)

docker-omni-key: ## How to mint the OmniRoute API key that OMNIROUTE_API_KEY carries
	@echo "1. open http://127.0.0.1:20128 and log in"
	@echo "   password: OMNIROUTE_INITIAL_PASSWORD in .env"
	@echo "2. connect a provider that serves the deepseek-* models dsh requests"
	@echo "3. Dashboard -> API Keys -> Create API Key (the key is shown only once)"
	@echo "4. set OMNIROUTE_API_KEY in .env, then rerun 'make docker-omni-web' or 'make docker-all-omni'"
	@echo "   DEEPSEEK_API_KEY stays the real DeepSeek key for the direct-mode targets"
	@echo "5. verify with 'make docker-omni-check'"

docker-omni-check: ## Check running harness services can actually reach the gateway
	@for svc in web api; do \
		if ! docker compose ps --status running --services 2>/dev/null | grep -qx "$$svc"; then \
			echo "$$svc: not running"; continue; \
		fi; \
		docker compose exec -T "$$svc" node -e '''const b=process.env.DEEPSEEK_BASE_URL;if(!b){console.log(process.argv[1]+": DEEPSEEK_BASE_URL unset");process.exit(0)}fetch(b+"/models",{headers:{Authorization:"Bearer "+(process.env.DEEPSEEK_API_KEY||"")}}).then(r=>console.log(process.argv[1]+": HTTP "+r.status+(r.status===200?" ok":r.status===401?" reachable, but OMNIROUTE_API_KEY is unset or invalid":""))).catch(e=>console.log(process.argv[1]+": unreachable - "+e.message))''' "$$svc" 2>/dev/null || echo "$$svc: check failed"; \
	done

# The default full stack: RavenStack's Traefik in front of web and API, with
# DeepSeek going straight to the public API. The OmniRoute gateway is opt-in
# (docker-all-omni); this target neither starts it nor wires the services to it,
# so a deployment that never configured OmniRoute brings the stack up cleanly and
# each service's DeepSeek key is set from the web Models page rather than injected.
docker-all: COMPOSE_FILE := $(RAVEN_COMPOSE_FILE)
docker-all: ## Run the full stack: Traefik + web and API, DeepSeek direct to the public API
	@test -f certs/harness.crt || ./docker/certs/generate.sh
	@$(MAKE) --no-print-directory docker-infra
	docker compose up web web-proxy api api-proxy

# Gateway variant of docker-all: additionally route model traffic through
# OmniRoute. Traefik and the gateway are separate compose projects, each owning
# one of the external networks the harness services attach to, so no
# `depends_on` can order them against those services. This target sequences the
# three projects instead. Both prerequisites are `up -d` and idempotent, so
# rerunning it against a running stack only reconciles what drifted.
docker-all-omni: COMPOSE_FILE := $(ALL_COMPOSE_FILE)
docker-all-omni: ## Run the full stack with model traffic routed through the OmniRoute gateway
	@test -f certs/harness.crt || ./docker/certs/generate.sh
	@$(MAKE) --no-print-directory docker-infra
	@$(MAKE) --no-print-directory docker-omni
	@# The gateway starts before this check on purpose: OMNIROUTE_API_KEY is
	@# minted from the dashboard the previous step just started, so checking
	@# first would leave a first-time user with nothing to mint from. Compose's
	@# own `:?` failure names the variable and the target that explains it; this
	@# adds only the fact that the dashboard is now reachable.
	@docker compose config -q || { \
		echo "the gateway is up at http://127.0.0.1:20128, so the key can be minted now; rerun 'make docker-all-omni' once .env carries it"; \
		exit 1; }
	docker compose up web web-proxy api api-proxy

# Reverse order: an external network cannot be removed while containers are
# still attached to it. The harness services come down under the base file
# alone, because `down` selects by compose project rather than by file set, and
# reading the omni-wire overlay here would fail interpolation for exactly the
# user who never minted a key.
docker-all-down: ## Stop the whole stack: harness services, then the gateway and Traefik
	docker compose down
	@$(MAKE) --no-print-directory docker-omni-down
	@$(MAKE) --no-print-directory docker-infra-down

docker-headless: ## Run a headless dsh task against the public API; usage: make docker-headless ARGS="..."
	docker compose run --rm headless $(ARGS)

docker-down: ## Stop and remove docker compose services
	docker compose down

docker-logs: ## Follow docker compose logs
	docker compose logs -f

docker-patch-plugins: ## Reapply patches/dsh-llm-local-token to the running profiles
	@for svc in $(PATCHED_SERVICES); do \
		if ! docker compose ps --status running --services 2>/dev/null | grep -qx "$$svc"; then \
			echo "skip $$svc: service is not running"; continue; \
		fi; \
		lib="/root/.dsh/profiles/$$svc/$(PLUGIN_LIB)"; \
		if ! docker compose exec -T "$$svc" test -d "$$lib" 2>/dev/null; then \
			echo "skip $$svc: dsh-llm-local-token is not installed in profile $$svc"; continue; \
		fi; \
		for f in claude-keychain.js token-store.js; do \
			docker compose exec -T "$$svc" sh -c "test -f $$lib/$$f.orig || cp $$lib/$$f $$lib/$$f.orig"; \
			docker compose cp "patches/dsh-llm-local-token/$$f" "$$svc:$$lib/$$f" >/dev/null 2>&1; \
		done; \
		echo "patched $$svc"; \
		docker compose restart "$$svc" >/dev/null; \
		echo "restarted $$svc"; \
	done
	@# web-proxy shares the web service network namespace, so it cannot rejoin
	@# a namespace a restart replaced; it must be recreated, not restarted.
	@for pair in "web web-proxy" "api api-proxy"; do \
		set -- $$pair; \
		if docker compose ps --status running --services 2>/dev/null | grep -qx "$$2"; then \
			docker compose up -d --force-recreate "$$2" >/dev/null 2>&1 && echo "recreated $$2"; \
		fi; \
	done
	@$(MAKE) --no-print-directory docker-check-plugins

docker-check-plugins: ## Report which local-token routes each running profile serves
	@for svc in $(PATCHED_SERVICES); do \
		if ! docker compose ps --status running --services 2>/dev/null | grep -qx "$$svc"; then \
			echo "$$svc: not running"; continue; \
		fi; \
		case "$$svc" in api) port=3081 ;; *) port=3080 ;; esac; \
		routes=$$(docker compose exec -T "$$svc" node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/llm-local-token/usage").then(r=>r.json()).then(d=>console.log(d.providers.map(p=>p.provider).join(", "))).catch(()=>console.log("UNAVAILABLE"))' "$$port" 2>/dev/null | tr -d "\r"); \
		if [ -z "$$routes" ] || [ "$$routes" = "UNAVAILABLE" ]; then \
			echo "$$svc: usage route unavailable (plugin not loaded?)"; \
		else \
			echo "$$svc: $$routes"; \
		fi; \
	done
