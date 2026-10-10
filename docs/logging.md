# Logging

The Lambda writes one JSON record per event to its CloudWatch Logs log group
(`JwksEndpoint.logGroup`), in the
[Elastic Common Schema](https://www.elastic.co/docs/reference/ecs) (ECS) 8.11.
The request records use ECS's own web fields (`http.*`, `url.*`, `source.*`,
`user_agent.*`), so tooling that reads ECS needs no mapping. This page
describes what is logged and how to consume it.

It is the same logger design as `cdk-jwks-secret` and `cdk-jwks-parameter`, and
this page adds the web access events.

## Where the logs go

- **Log group.** The construct creates the log group and grants the Lambda's
  role write access to it only. It keeps logs for one year
  (`RetentionDays.ONE_YEAR`) and is retained by default. Override `retention`,
  `removalPolicy` and `encryptionKey` with `logGroupProps`.
- **Format.** The construct sets Lambda's Text log format, and the function
  writes each record to `process.stdout` as one line of JSON. Lambda adds a
  timestamp, request ID and level in front of lines written with `console.log`,
  so the function does not use it.
- **Volume.** One record per request, plus one when the function starts (a
  cold start). OpenID Connect servers cache a JWKS, so traffic is low; at about
  0.5 KB a record, a million requests is about 0.5 GB of
  [ingestion](https://aws.amazon.com/cloudwatch/pricing/). Turn the per-request
  records off with `logRequests: false`; failures to read a source are logged
  either way.

## Logging schema

Every record is a single JSON object with flat, dotted keys (for example
`"event.action"`). Fields ECS defines keep their ECS names and types.

### Fields on every event

| Field               | ECS type          | Presence    | Meaning                                                                                         |
| ------------------- | ----------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `@timestamp`        | `date`            | Every event | When the event was logged, in UTC, as an ISO 8601 string with milliseconds.                     |
| `message`           | `match_only_text` | Every event | Human-readable summary. Query the structured fields instead.                                    |
| `ecs.version`       | `keyword`         | Every event | The ECS version of the record, `8.11.0`.                                                        |
| `log.level`         | `keyword`         | Every event | `info` for a success, `error` for a failure.                                                    |
| `service.name`      | `keyword`         | Conditional | The Lambda function name, from `AWS_LAMBDA_FUNCTION_NAME`.                                      |
| `cloud.provider`    | `keyword`         | Every event | Always `aws`.                                                                                   |
| `cloud.region`      | `keyword`         | Conditional | The function's region, from `AWS_REGION`.                                                       |
| `event.category`    | `keyword[]`       | Every event | `process` for `start_function`, `web` for `serve_jwks`.                                         |
| `event.type`        | `keyword[]`       | Every event | `start`, `access`, or `error` for a failure to read a source.                                   |
| `event.action`      | `keyword`         | Every event | `start_function` or `serve_jwks`. The outcome is never part of it.                              |
| `event.outcome`     | `keyword`         | Every event | `success` or `failure`.                                                                         |
| `aws.xray.trace.id` | `keyword`         | Conditional | The X-Ray trace ID (the `Root` of `_X_AMZN_TRACE_ID`), when Lambda sets one for the invocation. |

### Fields on `serve_jwks`

One record per request, written once the response is decided, so it has both
the request and the response.

| Field                       | ECS type   | Presence                           | Meaning                                                                                              |
| --------------------------- | ---------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `event.id`                  | `keyword`  | Conditional                        | The request ID the gateway or Function URL assigned.                                                 |
| `event.duration`            | `long`     | Every event                        | How long the Lambda took, in nanoseconds, as ECS defines it.                                         |
| `event.reason`              | `keyword`  | Conditional                        | `not_found`, `method_not_allowed` or `source_unavailable`.                                           |
| `http.request.method`       | `keyword`  | Every event                        | The method of the request.                                                                           |
| `url.path`                  | `wildcard` | Every event                        | The path of the request, cut to 256 characters.                                                      |
| `http.response.status_code` | `long`     | Every event                        | `200`, `404`, `405` or `503`.                                                                        |
| `http.response.body.bytes`  | `long`     | Successes                          | The size of the response body.                                                                       |
| `source.ip`                 | `ip`       | With `logClientDetails`            | The address of the immediate caller (CloudFront's, behind CloudFront).                               |
| `network.forwarded_ip`      | `ip`       | With `logClientDetails`, when sent | The first `X-Forwarded-For` address.                                                                 |
| `user_agent.original`       | `keyword`  | With `logClientDetails`            | The `User-Agent` of the request.                                                                     |
| `error.type`                | `keyword`  | Failures                           | The error's class name, for `source_unavailable`.                                                    |
| `error.message`             | `keyword`  | Conditional                        | Only for errors whose messages are safe to log; see [Sensitive-data policy](#sensitive-data-policy). |
| `jwks.keys`                 | `long`     | Successes                          | The number of keys served.                                                                           |
| `jwks.sources`              | `long`     | Successes                          | The number of sources read.                                                                          |
| `jwks.cache.hit`            | `boolean`  | Successes                          | Whether every source came from the cache.                                                            |

`start_function` carries `jwks.sources`, `jwks.cache.ttl_seconds` and
`url.path`. ECS has no fields for a JWK, so the `jwks.*` fields are project
extensions.

### Sensitive-data policy

- **Key material is never logged.** No JWK member is written to the log, and
  neither is a secret or parameter value. `test/assets/lambda/handlers/endpoint.test.ts`
  asserts that no private member of a stored key appears in the output.
- **Error messages are logged only when they are safe.** `error.message` is set
  for `JwksValidationError` (which this package writes) and for Secrets Manager
  and Systems Manager SDK exceptions. Any other error, such as one a library
  throws, might echo its input, so only its `error.type` is logged.
- **Values are data, not markup.** Each record is built with `JSON.stringify`,
  so a path with a line break or a quote cannot end the record or add a field,
  and it is truncated to 256 characters.
- **Client details are optional.** `source.ip` and `user_agent.original` are
  personal data in some regimes; `logClientDetails: false` leaves them out.
- **The path and sources' presence are logged.** Treat the log group with the
  same access controls as the secrets' metadata.

## Event index

| Event                      | Level | `event.category` | `event.type` | `event.action`   | `event.outcome` | Status |
| -------------------------- | ----- | ---------------- | ------------ | ---------------- | --------------- | ------ |
| Function started           | info  | `process`        | `start`      | `start_function` | `success`       |        |
| Function failed to start   | error | `process`        | `error`      | `start_function` | `failure`       |        |
| JWKS served                | info  | `web`            | `access`     | `serve_jwks`     | `success`       | 200    |
| Wrong method               | error | `web`            | `access`     | `serve_jwks`     | `failure`       | 405    |
| Other path                 | error | `web`            | `access`     | `serve_jwks`     | `failure`       | 404    |
| A source could not be read | error | `web`            | `error`      | `serve_jwks`     | `failure`       | 503    |

A `405` or `404` is a client error, so its `event.type` stays `access`; only a
failure on this side, `503`, is an `error`. A `404` or `405` from a gateway
that never reached the Lambda is not logged here.

## Consuming the logs

Query with CloudWatch Logs Insights on the log group:

```
fields @timestamp, `http.response.status_code`, `url.path`, `jwks.cache.hit`, `user_agent.original`
| filter `event.action` = "serve_jwks"
| sort @timestamp desc
```

Failures to read a source:

```
fields @timestamp, `event.reason`, `error.type`, `error.message`
| filter `event.action` = "serve_jwks" and `event.outcome` = "failure" and `http.response.status_code` = 503
| sort @timestamp desc
```

### Alarms

- **A source is unreadable.** Alarm on a metric filter for
  `{ $.['http.response.status_code'] = 503 }` on the log group (the field names
  contain dots, so they are written in single-quoted brackets), or on the
  Lambda's `Errors` metric together with the front door's 5XX metric. A `503`
  is not a Lambda error, so the `Errors` metric alone misses it.
- **The function cannot start.** Alarm on `{ $.['event.action'] = "start_function"
&& $.['event.outcome'] = "failure" }`: a misconfigured environment fails every
  request.
