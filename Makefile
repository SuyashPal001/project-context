REPO_ROOT ?= $(shell git rev-parse --show-toplevel 2>/dev/null)
ifeq ($(REPO_ROOT),)
  REPO_ROOT := $(abspath $(ARTIFACTS_DIR)/../../..)
endif
ESBUILD   := $(REPO_ROOT)/node_modules/.bin/esbuild
PNPM      := pnpm
ESBUILD_FLAGS := --bundle --platform=node --target=es2020 --minify --sourcemap \
  --external:@aws-sdk/*

# Every Lambda entry point below imports @serverless-saas/agent-* packages,
# which publish "main": "dist/index.js" — esbuild resolves straight to that
# compiled dist, not the TS source, and will silently bundle a stale dist if
# nobody happened to run `pnpm build` in that package recently. This target
# is a prerequisite of every build-* target below so a stale dist is no
# longer possible to ship: `pnpm -r --filter` respects the workspace
# dependency graph, so schema builds before the packages that import it.
# (See the incident this fixed: 2026-09-12, agents.origin column silently
# undefined at runtime because packages/schema's dist predated the column.)
.PHONY: build-product-packages
build-product-packages:
	cd $(REPO_ROOT) && $(PNPM) --filter "./products/agent-platform/packages/*" run build

build-FoundationApiFunction: build-product-packages
	$(ESBUILD) $(REPO_ROOT)/apps/api/src/index.ts \
	  --outfile=$(ARTIFACTS_DIR)/index.js \
	  $(ESBUILD_FLAGS)

build-FoundationPretokenFunction: build-product-packages
	$(ESBUILD) $(REPO_ROOT)/apps/api/src/pretoken.ts \
	  --outfile=$(ARTIFACTS_DIR)/pretoken.js \
	  $(ESBUILD_FLAGS)

build-FoundationWorkerFunction: build-product-packages
	$(ESBUILD) $(REPO_ROOT)/apps/worker/src/lambda.ts \
	  --outfile=$(ARTIFACTS_DIR)/lambda.js \
	  $(ESBUILD_FLAGS)

build-FoundationWebSocketFunction: build-product-packages
	$(ESBUILD) $(REPO_ROOT)/apps/api/src/websocket.ts \
	  --outfile=$(ARTIFACTS_DIR)/websocket.js \
	  $(ESBUILD_FLAGS)

build-TaskWorkerFunction: build-product-packages
	$(ESBUILD) $(REPO_ROOT)/products/agent-platform/packages/api/workers/taskWorker.ts \
	  --outfile=$(ARTIFACTS_DIR)/taskWorker.js \
	  $(ESBUILD_FLAGS)

build-WatchdogFunction: build-product-packages
	$(ESBUILD) $(REPO_ROOT)/products/agent-platform/packages/api/handlers/watchdogHandler.ts \
	  --outfile=$(ARTIFACTS_DIR)/watchdogHandler.js \
	  $(ESBUILD_FLAGS)

build-CreditsExpireFunction: build-product-packages
	$(ESBUILD) $(REPO_ROOT)/apps/worker/src/creditsExpireHandler.ts \
	  --outfile=$(ARTIFACTS_DIR)/creditsExpireHandler.js \
	  $(ESBUILD_FLAGS)

build-CreditsRenewFunction: build-product-packages
	$(ESBUILD) $(REPO_ROOT)/apps/worker/src/creditsRenewHandler.ts \
	  --outfile=$(ARTIFACTS_DIR)/creditsRenewHandler.js \
	  $(ESBUILD_FLAGS)
