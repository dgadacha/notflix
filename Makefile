# notflix — one-command dev + build helpers.
# Usage:
#   make dev      # frontend + backend in parallel (Ctrl+C stops both)
#   make build    # standalone binary with embedded web UI
#   make run      # build + run the prod binary
#   make clean    # remove build artifacts (keeps your data dir)
#
# Override defaults inline, e.g. `make dev DATADIR=/tmp/notflix PORT=43000`.

DATADIR ?= $$HOME/.notflix-data
# 43212 is the notflix default — cohabite with Kuro on 43211
PORT    ?= 43212
GO      ?= go
NPM     ?= npm

.DEFAULT_GOAL := help
.PHONY: help dev backend frontend setup install-deps init-config build run clean

help:
	@printf "notflix Makefile — targets:\n"
	@grep -E '^[a-zA-Z_-]+:[^=]*##' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

dev: setup ## Run frontend (43210) + backend ($(PORT)) together
	@printf "\n  Frontend  → http://127.0.0.1:43210\n  Backend   → http://127.0.0.1:$(PORT)\n  Datadir   → $(DATADIR)\n  Ctrl+C to stop both.\n\n"
	@trap 'kill 0' INT TERM; \
	  $(MAKE) -s backend & \
	  $(MAKE) -s frontend & \
	  wait

backend: ## Run only the Go backend
	@set -a; [ -f .env ] && . ./.env; set +a; \
	  $(GO) run main.go --datadir="$(DATADIR)"

frontend: ## Run only the web dev server
	@cd notflix-web && $(NPM) run dev

setup: init-config install-deps ## Prepare data dir, dummy web/, npm deps
	@mkdir -p web
	@[ -f web/index.html ] || : > web/index.html

install-deps:
	@if [ ! -d notflix-web/node_modules ]; then \
	  echo "→ installing npm deps (one-off)..."; \
	  cd notflix-web && $(NPM) install; \
	fi

init-config:
	@mkdir -p "$(DATADIR)"
	@if [ ! -f "$(DATADIR)/config.toml" ]; then \
	  printf '[server]\nhost = "0.0.0.0"\nport = %s\n' "$(PORT)" > "$(DATADIR)/config.toml"; \
	  echo "→ wrote $(DATADIR)/config.toml"; \
	elif ! grep -q "port = $(PORT)" "$(DATADIR)/config.toml"; then \
	  echo "→ updating port to $(PORT) in $(DATADIR)/config.toml"; \
	  sed -i '' -E "s/^port = [0-9]+/port = $(PORT)/" "$(DATADIR)/config.toml"; \
	fi

build: ## Build the standalone binary (web embedded)
	@echo "→ building web..."
	@cd notflix-web && $(NPM) install && $(NPM) run build
	@rm -rf web && mv notflix-web/out web
	@echo "→ building Go binary..."
	@CGO_ENABLED=1 $(GO) build -o notflix -trimpath -ldflags="-s -w"
	@echo "→ done: ./notflix"

run: build ## Build then launch the prod binary
	@./notflix --datadir="$(DATADIR)"

clean: ## Remove build artifacts (web/, notflix, notflix-web/out)
	@rm -rf web notflix notflix-web/out
	@echo "→ cleaned. Your datadir at $(DATADIR) is untouched."
