# -------------------------------------------------------
# Locals
# -------------------------------------------------------
locals {
  name_prefix = "${var.project}-${var.environment}"
  ssm_prefix  = "/${var.project}/${var.environment}"
}

# -------------------------------------------------------
# Data: WebSocket Lambda (deployed by SAM)
# -------------------------------------------------------
data "aws_lambda_function" "websocket" {
  function_name = "${var.project}-foundation-websocket-${var.environment}"
}

# -------------------------------------------------------
# Module: Cognito
# -------------------------------------------------------
module "cognito" {
  source = "../modules/auth/aws/cognito"

  user_pool_name                  = "${local.name_prefix}-user-pool"
  domain_prefix                   = var.cognito_domain_prefix
  pre_token_generation_lambda_arn = var.pre_token_generation_lambda_arn
  deletion_protection             = false
  mfa_configuration               = "OFF"
  advanced_security_mode          = "OFF"

  password_policy = {
    minimum_length                   = 8
    require_uppercase                = true
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  app_clients = {
    web = {
      name                        = "${local.name_prefix}-web-client"
      access_token_validity_hours = 1
      id_token_validity_hours     = 1
      refresh_token_validity_days = 30
      explicit_auth_flows = [
        "ALLOW_USER_SRP_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_ADMIN_USER_PASSWORD_AUTH"
      ]
      allowed_oauth_flows          = ["code"]
      allowed_oauth_scopes         = ["email", "openid", "profile"]
      callback_urls                = var.cognito_callback_urls
      logout_urls                  = var.cognito_logout_urls
      supported_identity_providers = ["COGNITO","Google"]
      read_attributes              = ["email", "email_verified", "name", "custom:tenantId", "custom:role", "custom:plan"]
      write_attributes             = ["email", "name"]
      generate_secret              = false
    }
  }

  email_configuration = null
  identity_providers = {
    google = {
      provider_name = "Google"
      provider_type = "Google"
      provider_details = {
        client_id        = var.google_client_id
        client_secret    = var.google_client_secret
        authorize_scopes = "email openid profile"
      }
      attribute_mapping = {
        email          = "email"
        email_verified = "email_verified"
        name           = "name"
        username       = "sub"
      }
    }
  }
  tags                = {}
}

# -------------------------------------------------------
# Module: SQS — Processing + Workflow queues
# Both queues in one module call — each gets its own DLQ
# -------------------------------------------------------
module "sqs" {
  source = "../modules/messaging/aws/sqs"

  queues = {
    processing = {
      name                       = var.processing_queue_name
      visibility_timeout_seconds = var.visibility_timeout_seconds
      message_retention_seconds  = var.message_retention_seconds
    }
    workflow = {
      name                       = var.workflow_queue_name
      visibility_timeout_seconds = var.visibility_timeout_seconds
      message_retention_seconds  = var.message_retention_seconds
    }
    agent_task = {
      name                       = var.agent_task_queue_name
      visibility_timeout_seconds = 360
      message_retention_seconds  = var.message_retention_seconds
    }
  }

  tags = {}
}

# -------------------------------------------------------
# Module: SNS — Events Topic
# -------------------------------------------------------
module "sns_events" {
  source = "../modules/messaging/aws/sns"

  topics = {
    events = {
      name = var.events_topic_name
    }
  }
  tags = {}
}

# -------------------------------------------------------
# Module: EventBridge — Custom Event Bus
# -------------------------------------------------------
resource "aws_sqs_queue_policy" "workflow_eventbridge" {
  queue_url = module.sqs.queue_urls["workflow"]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowEventBridgeToSendMessage"
        Effect = "Allow"
        Principal = {
          Service = "events.amazonaws.com"
        }
        Action   = "sqs:SendMessage"
        Resource = module.sqs.queue_arns["workflow"]
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = aws_cloudwatch_event_rule.workflow_scheduler.arn
          }
        }
      }
    ]
  })
}

# -------------------------------------------------------
# Module: EventBridge — Custom Event Bus
# -------------------------------------------------------
module "eventbridge" {
  source = "../modules/messaging/aws/eventbridge"

  buses = {
    main = {
      name = var.event_bus_name
    }
  }
  tags = {}
}

# -------------------------------------------------------
# Scheduled workflow trigger — default event bus
# Schedule rules are not supported on custom event buses;
# they must use the default event bus.
# -------------------------------------------------------
resource "aws_cloudwatch_event_rule" "workflow_scheduler" {
  name                = "${local.name_prefix}-workflow-scheduler"
  description         = "Fires scheduled agent workflows every 5 minutes"
  schedule_expression = "rate(5 minutes)"
  # No event_bus_name — uses default event bus
}

resource "aws_cloudwatch_event_target" "workflow_scheduler" {
  rule      = aws_cloudwatch_event_rule.workflow_scheduler.name
  target_id = "workflow-sqs"
  arn       = module.sqs.queue_arns["workflow"]

  input_transformer {
    input_template = jsonencode({
      type = "workflow.fire"
    })
  }
}

# -------------------------------------------------------
# Module: CloudWatch — Log Groups
# -------------------------------------------------------
module "cloudwatch" {
  source = "../modules/observability/aws/cloudwatch"

  log_groups = {
    api_gateway = {
      name              = "/aws/apigateway/${local.name_prefix}"
      retention_in_days = var.log_retention_days
    }
    foundation_api = {
      name              = "/aws/lambda/${local.name_prefix}-foundation-api"
      retention_in_days = var.log_retention_days
    }
    foundation_worker = {
      name              = "/aws/lambda/${local.name_prefix}-foundation-worker"
      retention_in_days = var.log_retention_days
    }
    foundation_pretoken = {
      name              = "/aws/lambda/${local.name_prefix}-foundation-pretoken"
      retention_in_days = var.log_retention_days
    }
    task_worker = {
      name              = "/aws/lambda/${local.name_prefix}-task-worker"
      retention_in_days = var.log_retention_days
    }
  }
  tags = {}
}

# -------------------------------------------------------
# Module: API Gateway
# -------------------------------------------------------
module "api_gateway" {
  source = "../modules/api-gateway/aws/http-api"

  name                 = var.api_name
  access_log_group_arn = module.cloudwatch.log_group_arns["api_gateway"]

  jwt_authorizer = {
    issuer   = "https://cognito-idp.${var.region}.amazonaws.com/${module.cognito.user_pool_id}"
    audience = [module.cognito.app_client_ids["web"]]
  }

  cors = {
    allow_origins = var.cors_allow_origins
  }

  integrations = {
    foundation_api = {
      lambda_arn = var.foundation_api_lambda_arn
    }
  }

  routes = {
    google_oauth_callback = {
      route_key       = "GET /api/v1/integrations/google/callback"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    zoho_oauth_callback = {
      route_key       = "GET /api/v1/integrations/zoho/callback"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    jira_oauth_callback = {
      route_key       = "GET /api/v1/integrations/jira/callback"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    api = {
      route_key       = "ANY /api/v1/{proxy+}"
      integration_key = "foundation_api"
      requires_auth   = true
    }
    health = {
      route_key       = "GET /health"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    health_ready = {
      route_key       = "GET /health/ready"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    check_email = {
      route_key       = "GET /api/v1/auth/check-email"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    invitations_get = {
      route_key       = "GET /api/v1/invitations/{proxy+}"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    invitations_accept = {
      route_key       = "POST /api/v1/invitations/{proxy+}"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    onboarding = {
      route_key       = "POST /api/v1/onboarding/complete"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    # Client handover portal. Clients are not users — they hold no account and
    # no JWT — so the pack link must resolve without the gateway authorizer.
    # Authorisation is the 43-char token in the path, verified against a stored
    # sha256 by the handler, which returns an identical 404 for an unknown,
    # draft, revoked, or deleted pack. The handler also rate-limits per IP,
    # since these routes bypass the middleware chain entirely.
    packs_get = {
      route_key       = "GET /api/v1/packs/{proxy+}"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    packs_sign = {
      route_key       = "POST /api/v1/packs/{proxy+}"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    api_internal = {
      route_key       = "POST /api/v1/internal/{proxy+}"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    api_internal_get = {
      route_key       = "GET /api/v1/internal/{proxy+}"
      integration_key = "foundation_api"
      requires_auth   = false
    }
    }

  tags = {}
}

# -------------------------------------------------------
# API Gateway: WebSocket API
# -------------------------------------------------------
resource "aws_apigatewayv2_api" "ws_api" {
  name                         = "${var.project}-websocket-${var.environment}"
  protocol_type                = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_apigatewayv2_integration" "ws_lambda" {
  api_id           = aws_apigatewayv2_api.ws_api.id
  integration_type = "AWS_PROXY"
  integration_uri  = data.aws_lambda_function.websocket.invoke_arn
}

resource "aws_apigatewayv2_route" "connect" {
  api_id    = aws_apigatewayv2_api.ws_api.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_lambda.id}"
}

resource "aws_apigatewayv2_route" "disconnect" {
  api_id    = aws_apigatewayv2_api.ws_api.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_lambda.id}"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.ws_api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.ws_lambda.id}"
}

resource "aws_apigatewayv2_stage" "ws" {
  api_id      = aws_apigatewayv2_api.ws_api.id
  name        = var.environment
  auto_deploy = true
}

# -------------------------------------------------------
# Lambda Permissions for WebSocket API
# -------------------------------------------------------
resource "aws_lambda_permission" "allow_ws_connect" {
  statement_id  = "AllowAPIGatewayWSConnect"
  action        = "lambda:InvokeFunction"
  function_name = data.aws_lambda_function.websocket.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws_api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "allow_ws_disconnect" {
  statement_id  = "AllowAPIGatewayWSDisconnect"
  action        = "lambda:InvokeFunction"
  function_name = data.aws_lambda_function.websocket.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws_api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "allow_ws_default" {
  statement_id  = "AllowAPIGatewayWSDefault"
  action        = "lambda:InvokeFunction"
  function_name = data.aws_lambda_function.websocket.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws_api.execution_arn}/*/*"
}

# -------------------------------------------------------
# Module: Event Source Mapping — SQS → Worker Lambda
# -------------------------------------------------------
module "esm" {
  source = "../modules/integration/aws/event-source-mapping"

  sqs_mappings = {
    processing = {
      queue_arn  = module.sqs.queue_arns["processing"]
      lambda_arn = var.foundation_worker_lambda_arn
      batch_size = 10
    }
    agent_task = {
      queue_arn  = module.sqs.queue_arns["agent_task"]
      lambda_arn = var.task_worker_lambda_arn
      batch_size = 1
    }
  }
}

# -------------------------------------------------------
# Module: IAM — Lambda execution roles
# -------------------------------------------------------
module "iam" {
  source = "../modules/iam/aws/role"

  roles = {
    foundation_api = {
      name        = "${local.name_prefix}-foundation-api-role"
      description = "Execution role for foundation API Lambda (Hono HTTP handler)"
      assume_role_policy = jsonencode({
        Version = "2012-10-17"
        Statement = [{
          Effect    = "Allow"
          Principal = { Service = "lambda.amazonaws.com" }
          Action    = "sts:AssumeRole"
        }]
      })
      policy_arns = [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
      ]
      inline_policies = {
        ssm_read = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
            Resource = "arn:aws:ssm:${var.region}:*:parameter/${var.project}/${var.environment}/*"
          }]
        })
        secrets_read = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["secretsmanager:GetSecretValue"]
            Resource = "arn:aws:secretsmanager:${var.region}:*:secret:${var.project}/${var.environment}/*"
          }]
        })
        sqs_publish = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect = "Allow"
            Action = ["sqs:SendMessage"]
            Resource = [
              module.sqs.queue_arns["processing"],
              module.sqs.queue_arns["workflow"],
              module.sqs.queue_arns["agent_task"],
            ]
          }]
        })
        sns_publish = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["sns:Publish"]
            Resource = module.sns_events.topic_arns["events"]
          }]
        })
        eventbridge_publish = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["events:PutEvents"]
            Resource = module.eventbridge.bus_arns["main"]
          }]
        })
        cognito_idp = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action = [
              "cognito-idp:AdminInitiateAuth",
              "cognito-idp:AdminRespondToAuthChallenge",
              "cognito-idp:AdminGetUser",
              "cognito-idp:AdminUpdateUserAttributes",
              "cognito-idp:AdminSetUserPassword"
            ]
            Resource = module.cognito.user_pool_arn
          }]
        })
        ses_send = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["ses:SendEmail", "ses:SendRawEmail"]
            Resource = module.ses.domain_identity_arn
          }]
        })
        manage_connections = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = "execute-api:ManageConnections"
            Resource = "arn:aws:execute-api:${var.region}:*:${aws_apigatewayv2_api.ws_api.id}/*"
          }]
        })
      }
    }

    foundation_worker = {
      name        = "${local.name_prefix}-foundation-worker-role"
      description = "Execution role for foundation Worker Lambda (SQS consumer)"
      assume_role_policy = jsonencode({
        Version = "2012-10-17"
        Statement = [{
          Effect    = "Allow"
          Principal = { Service = "lambda.amazonaws.com" }
          Action    = "sts:AssumeRole"
        }]
      })
      policy_arns = [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole",
        "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
      ]
      inline_policies = {
        ssm_read = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
            Resource = "arn:aws:ssm:${var.region}:*:parameter/${var.project}/${var.environment}/*"
          }]
        })
        secrets_read = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["secretsmanager:GetSecretValue"]
            Resource = "arn:aws:secretsmanager:${var.region}:*:secret:${var.project}/${var.environment}/*"
          }]
        })
        s3_documents = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect = "Allow"
            Action = [
              "s3:GetObject",
              "s3:PutObject",
              "s3:DeleteObject",
              "s3:ListBucket"
            ]
            Resource = [
              "arn:aws:s3:::${var.project}-${var.environment}-files",
              "arn:aws:s3:::${var.project}-${var.environment}-files/*"
            ]
          }]
        })
        sns_publish = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["sns:Publish"]
            Resource = module.sns_events.topic_arns["events"]
          }]
        })
        eventbridge_publish = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["events:PutEvents"]
            Resource = module.eventbridge.bus_arns["main"]
          }]
        })
      }
    }

    foundation_pretoken = {
      name        = "${local.name_prefix}-foundation-pretoken-role"
      description = "Execution role for Pre Token Generation Lambda (Cognito trigger)"
      assume_role_policy = jsonencode({
        Version = "2012-10-17"
        Statement = [{
          Effect    = "Allow"
          Principal = { Service = "lambda.amazonaws.com" }
          Action    = "sts:AssumeRole"
        }]
      })
      policy_arns = [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
      ]
      inline_policies = {
        ssm_read = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
            Resource = "arn:aws:ssm:${var.region}:*:parameter/${var.project}/${var.environment}/*"
          }]
        })
        secrets_read = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["secretsmanager:GetSecretValue"]
            Resource = "arn:aws:secretsmanager:${var.region}:*:secret:${var.project}/${var.environment}/*"
          }]
        })
      }
    }

    foundation_websocket = {
      name        = "${local.name_prefix}-foundation-websocket-role"
      description = "Execution role for foundation WebSocket Lambda"
      assume_role_policy = jsonencode({
        Version = "2012-10-17"
        Statement = [{
          Effect    = "Allow"
          Principal = { Service = "lambda.amazonaws.com" }
          Action    = "sts:AssumeRole"
        }]
      })
      policy_arns = [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
      ]
      inline_policies = {
        ssm_read = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
            Resource = "arn:aws:ssm:${var.region}:*:parameter/${var.project}/${var.environment}/*"
          }]
        })
        secrets_read = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["secretsmanager:GetSecretValue"]
            Resource = "arn:aws:secretsmanager:${var.region}:*:secret:${var.project}/${var.environment}/*"
          }]
        })
        manage_connections = jsonencode({
            Version = "2012-10-17"
            Statement = [{
                Effect = "Allow"
                Action = "execute-api:ManageConnections"
                Resource = "arn:aws:execute-api:${var.region}:*:${aws_apigatewayv2_api.ws_api.id}/*"
            }]
        })
      }
    }

    task_worker = {
      name        = "${local.name_prefix}-task-worker-role"
      description = "Execution role for Task Worker Lambda (SQS consumer)"
      assume_role_policy = jsonencode({
        Version = "2012-10-17"
        Statement = [{
          Effect    = "Allow"
          Principal = { Service = "lambda.amazonaws.com" }
          Action    = "sts:AssumeRole"
        }]
      })
      policy_arns = [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole",
        "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
      ]
      inline_policies = {
        ssm_read = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
            Resource = "arn:aws:ssm:${var.region}:*:parameter/${var.project}/${var.environment}/*"
          }]
        })
        secrets_read = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = ["secretsmanager:GetSecretValue"]
            Resource = "arn:aws:secretsmanager:${var.region}:*:secret:${var.project}/${var.environment}/*"
          }]
        })
        sqs_consume = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect = "Allow"
            Action = [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes"
            ]
            Resource = module.sqs.queue_arns["agent_task"]
          }]
        })
        sqs_publish = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect = "Allow"
            Action = ["sqs:SendMessage"]
            Resource = [
              module.sqs.queue_arns["processing"],
              module.sqs.queue_arns["workflow"],
              module.sqs.queue_arns["agent_task"],
            ]
          }]
        })
        manage_connections = jsonencode({
          Version = "2012-10-17"
          Statement = [{
            Effect   = "Allow"
            Action   = "execute-api:ManageConnections"
            Resource = "arn:aws:execute-api:${var.region}:*:${aws_apigatewayv2_api.ws_api.id}/*"
          }]
        })
      }
    }
  }

  tags = {}
}

# -------------------------------------------------------
# SSM Bridge — Terraform writes, SAM reads
# -------------------------------------------------------
resource "aws_ssm_parameter" "cognito_user_pool_id" {
  name  = "${local.ssm_prefix}/cognito/user-pool-id"
  type  = "String"
  value = module.cognito.user_pool_id
}

resource "aws_ssm_parameter" "cognito_client_id" {
  name  = "${local.ssm_prefix}/cognito/client-id"
  type  = "String"
  value = module.cognito.app_client_ids["web"]
}

resource "aws_ssm_parameter" "cognito_jwks_uri" {
  name  = "${local.ssm_prefix}/cognito/jwks-uri"
  type  = "String"
  value = module.cognito.jwks_uri
}

resource "aws_ssm_parameter" "sqs_processing_queue_url" {
  name  = "${local.ssm_prefix}/sqs/processing-queue-url"
  type  = "String"
  value = module.sqs.queue_urls["processing"]
}

resource "aws_ssm_parameter" "sqs_workflow_queue_url" {
  name  = "${local.ssm_prefix}/sqs/workflow-queue-url"
  type  = "String"
  value = module.sqs.queue_urls["workflow"]
}

resource "aws_ssm_parameter" "sns_events_topic_arn" {
  name  = "${local.ssm_prefix}/sns/events-topic-arn"
  type  = "String"
  value = module.sns_events.topic_arns["events"]
}

resource "aws_ssm_parameter" "eventbridge_bus_name" {
  name  = "${local.ssm_prefix}/eventbridge/bus-name"
  type  = "String"
  value = module.eventbridge.bus_names["main"]
}

resource "aws_ssm_parameter" "api_gateway_id" {
  name  = "${local.ssm_prefix}/api-gateway/id"
  type  = "String"
  value = module.api_gateway.api_id
}

resource "aws_ssm_parameter" "api_gateway_url" {
  name  = "${local.ssm_prefix}/api-gateway/url"
  type  = "String"
  value = module.api_gateway.api_endpoint
}

resource "aws_ssm_parameter" "iam_foundation_api_role_arn" {
  name  = "${local.ssm_prefix}/iam/foundation-api-role-arn"
  type  = "String"
  value = module.iam.role_arns["foundation_api"]
}

resource "aws_ssm_parameter" "iam_foundation_worker_role_arn" {
  name  = "${local.ssm_prefix}/iam/foundation-worker-role-arn"
  type  = "String"
  value = module.iam.role_arns["foundation_worker"]
}

resource "aws_ssm_parameter" "iam_foundation_pretoken_role_arn" {
  name  = "${local.ssm_prefix}/iam/foundation-pretoken-role-arn"
  type  = "String"
  value = module.iam.role_arns["foundation_pretoken"]
}

resource "aws_ssm_parameter" "ws_token_secret" {
  name  = "${local.ssm_prefix}/ws-token-secret"
  type  = "SecureString"
  value = var.ws_token_secret
}

# -------------------------------------------------------
# SSM Bridge: WebSocket API
# -------------------------------------------------------
resource "aws_ssm_parameter" "ws_api_id" {
  name  = "/${var.project}/${var.environment}/api-gateway/ws-api-id"
  type  = "String"
  value = aws_apigatewayv2_api.ws_api.id
}

resource "aws_ssm_parameter" "ws_api_endpoint" {
  name  = "/${var.project}/${var.environment}/api-gateway/ws-api-endpoint"
  type  = "String"
  value = aws_apigatewayv2_stage.ws.invoke_url
}

resource "aws_ssm_parameter" "iam_foundation_websocket_role_arn" {
  name  = "/${var.project}/${var.environment}/iam/foundation-websocket-role-arn"
  type  = "String"
  value = module.iam.role_arns["foundation_websocket"]
}

resource "aws_ssm_parameter" "sqs_agent_task_queue_url" {
  name  = "${local.ssm_prefix}/sqs/agent-task-queue-url"
  type  = "String"
  value = module.sqs.queue_urls["agent_task"]
}

resource "aws_ssm_parameter" "iam_task_worker_role_arn" {
  name  = "${local.ssm_prefix}/iam/task-worker-role-arn"
  type  = "String"
  value = module.iam.role_arns["task_worker"]
}

resource "aws_secretsmanager_secret" "token_encryption_key" {
  name        = "${var.project}/${var.environment}/token-encryption-key"
  description = "AES-256-GCM master key for token encryption"
}

resource "aws_secretsmanager_secret" "google_oauth" {
  name        = "${var.project}/${var.environment}/google-oauth"
  description = "Google OAuth 2.0 client credentials (client_id, client_secret)"
}

resource "aws_secretsmanager_secret_version" "google_oauth" {
  secret_id     = aws_secretsmanager_secret.google_oauth.id
  secret_string = jsonencode({
    client_id     = var.google_client_id
    client_secret = var.google_client_secret
  })
}

resource "aws_secretsmanager_secret" "zoho_oauth" {
  name        = "${var.project}/${var.environment}/zoho-oauth"
  description = "Zoho OAuth 2.0 client credentials (client_id, client_secret)"
}

resource "aws_secretsmanager_secret" "jira_oauth" {
  name        = "${var.project}/${var.environment}/jira-oauth"
  description = "Atlassian OAuth 2.0 client credentials for Jira integration"
}

resource "aws_secretsmanager_secret" "github_app" {
  name        = "${var.project}/${var.environment}/github-app"
  description = "GitHub App credentials — JSON with app_id, app_slug, private_key, webhook_secret"
}

resource "aws_secretsmanager_secret" "gcp_sa_key" {
  name        = "${var.project}/${var.environment}/gcp-sa-key"
  description = "GCP service account key JSON — used for Vertex AI and document processing"
}

resource "aws_secretsmanager_secret" "internal_service_key" {
  name        = "${var.project}/${var.environment}/internal-service-key"
  description = "Shared secret for service-to-service auth (API, relay, agent-server, mcp-server)"
}

resource "aws_ssm_parameter" "jira_redirect_uri" {
  name  = "${local.ssm_prefix}/jira-redirect-uri"
  type  = "String"
  value = var.jira_redirect_uri
}

resource "aws_ssm_parameter" "google_redirect_uri" {
  name  = "${local.ssm_prefix}/google-redirect-uri"
  type  = "String"
  value = var.google_redirect_uri

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "zoho_redirect_uri" {
  name  = "${local.ssm_prefix}/zoho-redirect-uri"
  type  = "String"
  value = var.zoho_redirect_uri

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "relay_url" {
  name  = "${local.ssm_prefix}/relay-url"
  type  = "String"
  value = var.relay_url

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "frontend_url" {
  name  = "${local.ssm_prefix}/frontend-url"
  type  = "String"
  value = var.frontend_url

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_secretsmanager_secret" "database" {
  name = "${var.project}/${var.environment}/database"
}

resource "aws_secretsmanager_secret_version" "database" {
  secret_id     = aws_secretsmanager_secret.database.id
  secret_string = jsonencode({ url = var.database_url })
}

resource "aws_secretsmanager_secret" "cache" {
  name = "${var.project}/${var.environment}/cache"
}

resource "aws_secretsmanager_secret_version" "cache" {
  secret_id     = aws_secretsmanager_secret.cache.id
  secret_string = jsonencode({
    url   = var.upstash_redis_rest_url
    token = var.upstash_redis_rest_token
  })
}

# -------------------------------------------------------
# Module: SES — Sending domain
# -------------------------------------------------------
module "ses" {
  source      = "../modules/messaging/aws/ses"
  domain      = var.ses_from_domain
  environment = var.environment
  project     = var.project
}

resource "aws_ssm_parameter" "ses_from_email" {
  name  = "${local.ssm_prefix}/ses/from-email"
  type  = "String"
  value = "mail@${var.ses_from_domain}"
}

resource "aws_ssm_parameter" "ses_domain_identity_arn" {
  name  = "${local.ssm_prefix}/ses/domain-identity-arn"
  type  = "String"
  value = module.ses.domain_identity_arn
}

