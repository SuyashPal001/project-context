REPO_ROOT ?= $(shell git rev-parse --show-toplevel 2>/dev/null)
ifeq ($(REPO_ROOT),)
  REPO_ROOT := $(abspath $(ARTIFACTS_DIR)/../../..)
endif
ESBUILD   := $(REPO_ROOT)/node_modules/.bin/esbuild
ESBUILD_FLAGS := --bundle --platform=node --target=es2020 --minify --sourcemap \
  --conditions=require \
  --external:@aws-sdk/*

# Lambda entry points import @serverless-saas/* packages whose "main" is
# dist/index.js, so esbuild bundles compiled dist, not TS source. Rebuild it
# first or a stale dist ships silently (2026-09-24: /creative-library-assets
# missing from the deployed API). pnpm -r orders builds by dependency graph.
.PHONY: build-workspace-packages
build-workspace-packages:
	cd $(REPO_ROOT) && pnpm -r --filter "./packages/foundation/*" --filter "./products/agent-platform/packages/*" run build

build-FoundationApiFunction: build-workspace-packages
	$(ESBUILD) $(REPO_ROOT)/apps/api/src/index.ts \
	  --outfile=$(ARTIFACTS_DIR)/index.js \
	  $(ESBUILD_FLAGS)

build-FoundationPretokenFunction: build-workspace-packages
	$(ESBUILD) $(REPO_ROOT)/apps/api/src/pretoken.ts \
	  --outfile=$(ARTIFACTS_DIR)/pretoken.js \
	  $(ESBUILD_FLAGS)

build-FoundationWorkerFunction: build-workspace-packages
	$(ESBUILD) $(REPO_ROOT)/apps/worker/src/lambda.ts \
	  --outfile=$(ARTIFACTS_DIR)/lambda.js \
	  $(ESBUILD_FLAGS)

build-FoundationWebSocketFunction: build-workspace-packages
	$(ESBUILD) $(REPO_ROOT)/apps/api/src/websocket.ts \
	  --outfile=$(ARTIFACTS_DIR)/websocket.js \
	  $(ESBUILD_FLAGS)

build-TaskWorkerFunction: build-workspace-packages
	$(ESBUILD) $(REPO_ROOT)/products/agent-platform/packages/api/workers/taskWorker.ts \
	  --outfile=$(ARTIFACTS_DIR)/taskWorker.js \
	  $(ESBUILD_FLAGS)

build-WatchdogFunction: build-workspace-packages
	$(ESBUILD) $(REPO_ROOT)/products/agent-platform/packages/api/handlers/watchdogHandler.ts \
	  --outfile=$(ARTIFACTS_DIR)/watchdogHandler.js \
	  $(ESBUILD_FLAGS)
