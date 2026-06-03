REPO_ROOT ?= $(shell git rev-parse --show-toplevel 2>/dev/null)
ESBUILD   := $(REPO_ROOT)/node_modules/.bin/esbuild
ESBUILD_FLAGS := --bundle --platform=node --target=es2020 --minify --sourcemap \
  --conditions=require \
  --external:@aws-sdk/*

build-FoundationApiFunction:
	$(ESBUILD) $(REPO_ROOT)/apps/api/src/index.ts \
	  --outfile=$(ARTIFACTS_DIR)/index.js \
	  $(ESBUILD_FLAGS)

build-FoundationPretokenFunction:
	$(ESBUILD) $(REPO_ROOT)/apps/api/src/pretoken.ts \
	  --outfile=$(ARTIFACTS_DIR)/pretoken.js \
	  $(ESBUILD_FLAGS)

build-FoundationWorkerFunction:
	$(ESBUILD) $(REPO_ROOT)/apps/worker/src/lambda.ts \
	  --outfile=$(ARTIFACTS_DIR)/lambda.js \
	  $(ESBUILD_FLAGS)
