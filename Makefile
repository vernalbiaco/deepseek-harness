.DEFAULT_GOAL := help

.PHONY: help install build clean typecheck lint test test-coverage hygiene \
	docker-build docker-web docker-headless docker-down docker-logs \
	docker-raven docker-infra docker-infra-down docker-certs docker-certs-trust \
	docker-patch-plugins docker-check-plugins \
	docker-omni docker-omni-down docker-omni-web docker-omni-key docker-omni-check

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

docker-raven: ## Run web + API behind RavenStack's Traefik (harness.local.raven.com, harness-api.local.raven.com)
	docker compose -f docker-compose.yml -f docker-compose.raven.yml up web web-proxy api api-proxy

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

docker-infra-down: ## Remove the standalone infra Traefik and its network (stop raven services first)
	docker compose -f docker-compose.infra.yml down

docker-omni: ## Run the OmniRoute gateway + omniroute_network, detached (http://localhost:20128)
	docker compose -f docker-compose.omni.yml up -d

docker-omni-down: ## Remove the OmniRoute gateway and omniroute_network (stop wired services first)
	docker compose -f docker-compose.omni.yml down

docker-omni-web: ## Run web + API routed through OmniRoute (run 'make docker-omni' first)
	docker compose -f docker-compose.yml -f docker-compose.omni-wire.yml up web web-proxy api api-proxy

docker-omni-key: ## How to mint the OmniRoute API key that DEEPSEEK_API_KEY carries
	@echo "1. open http://127.0.0.1:20128 and log in"
	@echo "   password: OMNIROUTE_INITIAL_PASSWORD in .env"
	@echo "2. connect a provider that serves the deepseek-* models dsh requests"
	@echo "3. Dashboard -> Endpoints -> create a key"
	@echo "4. set DEEPSEEK_API_KEY in .env, then rerun 'make docker-omni-web'"
	@echo "5. verify with 'make docker-omni-check'"

docker-omni-check: ## Check running harness services can actually reach the gateway
	@for svc in web api; do \
		if ! docker compose ps --status running --services 2>/dev/null | grep -qx "$$svc"; then \
			echo "$$svc: not running"; continue; \
		fi; \
		docker compose exec -T "$$svc" node -e '''const b=process.env.DEEPSEEK_BASE_URL;if(!b){console.log(process.argv[1]+": DEEPSEEK_BASE_URL unset");process.exit(0)}fetch(b+"/models",{headers:{Authorization:"Bearer "+(process.env.DEEPSEEK_API_KEY||"")}}).then(r=>console.log(process.argv[1]+": HTTP "+r.status+(r.status===200?" ok":r.status===401?" reachable, but DEEPSEEK_API_KEY is unset or invalid":""))).catch(e=>console.log(process.argv[1]+": unreachable - "+e.message))''' "$$svc" 2>/dev/null || echo "$$svc: check failed"; \
	done

docker-headless: ## Run a headless dsh task; usage: make docker-headless ARGS="..."
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
