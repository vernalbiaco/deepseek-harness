.DEFAULT_GOAL := help

.PHONY: help install build clean typecheck lint test test-coverage hygiene \
	docker-build docker-web docker-headless docker-down docker-logs \
	docker-patch-plugins docker-check-plugins

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
