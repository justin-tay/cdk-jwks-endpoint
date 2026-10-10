# Exposures

An exposure decides how the endpoint is reached. Each factory of
`JwksExposure` builds its front door from `aws-cdk-lib` constructs and returns
them as properties of the `JwksEndpoint`, so you can attach what the construct
leaves to you: a domain, a WAF, throttling, alarms.

Every exposure serves the same JWKS from the same Lambda at the same `path`
(default `/.well-known/jwks.json`). Pick by what you need in front of it.

| **You need**                                         | **Use**            |
| ---------------------------------------------------- | ------------------ |
| The cheapest thing that works                        | `functionUrl()`    |
| Caching at the edge, or a CloudFront domain and WAF  | `cloudFront()`     |
| A custom domain with the least cost and no cache fee | `httpApi()`        |
| WAF, usage plans or API keys on the API itself       | `restApi()`        |
| The endpoint reachable only from inside a VPC        | `privateRestApi()` |

## How each answers

What a caller gets differs by who answers it, because a gateway refuses what it
has no route for before the Lambda runs. Only the Lambda writes an access
record, so a `403` or `404` from a gateway or CloudFront is not in the log.

| **Request**        | **Function URL**    | **CloudFront**      | **HTTP API** | **REST API** |
| ------------------ | ------------------- | ------------------- | ------------ | ------------ |
| `GET` the path     | 200                 | 200                 | 200          | 200          |
| `HEAD` the path    | 200, no body        | 200, no body        | 404          | 403          |
| `POST` the path    | 405 from the Lambda | 403 from CloudFront | 404          | 403          |
| `GET` another path | 404 from the Lambda | 404 from the Lambda | 404          | 403          |

Callers that fetch a JWKS use `GET`, so none of this matters for the
`jwks_uri` itself. It matters for health checks and uptime monitors, which
should `GET` the path.

## Function URL

```ts
new JwksEndpoint(this, 'Jwks', { sources });
// or: exposure: JwksExposure.functionUrl()
```

A public Function URL, free of charge and public by design: a JWKS contains
only public keys. The Lambda enforces the path (`404` otherwise) and the method
(`405`). It's the default, and the one to start with.

## CloudFront

```ts
const endpoint = new JwksEndpoint(this, 'Jwks', {
  sources,
  exposure: JwksExposure.cloudFront({ priceClass: PriceClass.PRICE_CLASS_ALL }),
});
endpoint.distribution; // attach a domain, certificate or WAF here
```

A distribution over a Function URL that **only CloudFront can call**: the URL
uses IAM authentication and the distribution signs requests with an origin
access control, so nobody can bypass it. The cache policy honours the
endpoint's `Cache-Control`, so `cacheTtl` is the one TTL to reason about.
Viewers must use HTTPS, and only `GET` and `HEAD` are allowed.

This exposure needs `aws-cdk-lib` 2.273.0 or later. A Function URL with IAM
authentication needs both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`,
and earlier versions of the CloudFront origin grant only the first, so CloudFront
gets a `403` from the Lambda
([aws/aws-cdk#35919](https://github.com/aws/aws-cdk/pull/35919)).

Without a custom domain, the distribution uses CloudFront's default certificate,
which cannot set a minimum TLS version. Add your own domain and certificate to
set one.

## HTTP API

```ts
new JwksEndpoint(this, 'Jwks', { sources, exposure: JwksExposure.httpApi() });
```

A regional HTTP API with one `GET` route. A good choice for a custom domain
without CloudFront. HTTP APIs have no response cache and no direct WAF
association; put CloudFront in front if you need either.

## REST API

```ts
const endpoint = new JwksEndpoint(this, 'Jwks', { sources, exposure: JwksExposure.restApi() });
endpoint.restApi; // add a usage plan, a domain, or a WAF association on its stage
```

A regional REST API with one unauthenticated `GET` method. Choose it when you
need what REST APIs have and HTTP APIs don't: a WAF web ACL on the stage, usage
plans and API keys, or request throttling per stage. To associate a WAF:

```ts
new CfnWebACLAssociation(this, 'WafAssociation', {
  resourceArn: endpoint.restApi!.deploymentStage.stageArn,
  webAclArn,
});
```

## Private REST API

```ts
const vpcEndpoint = InterfaceVpcEndpoint.fromInterfaceVpcEndpointAttributes(this, 'ExecuteApi', {
  vpcEndpointId: 'vpce-0123456789abcdef0',
  port: 443,
});

const endpoint = new JwksEndpoint(this, 'Jwks', {
  sources,
  exposure: JwksExposure.privateRestApi({ vpcEndpoints: [vpcEndpoint] }),
});
```

A REST API of type `PRIVATE`, reachable only through the `execute-api`
interface endpoints you give it. The construct writes the resource policy: it
**allows** `execute-api:Invoke` from those endpoints and **denies** every other
caller. HTTP APIs cannot be private, which is why this is a REST API.

- **The VPC endpoint is yours.** The construct never creates one, since an
  interface endpoint costs money for every hour it exists. Pass an existing
  `IVpcEndpoint`. Its security group must allow HTTPS from your clients, and
  its own endpoint policy can narrow things further.
- **`url` is the `execute-api` URL**, which resolves to the endpoint's private
  IP addresses only inside the VPC with private DNS enabled. To call it by
  another name, add a custom domain for private APIs, which is a different
  problem from public ones and not part of this construct.
- **The Lambda does not need to be in the VPC.** API Gateway invokes it as a
  service. Put it in a VPC with `lambdaProps` only if you have a reason; its
  subnets then need a route to Secrets Manager and Systems Manager, through VPC
  endpoints or NAT.

## What this construct leaves to you

| **Concern**          | **Where to add it**                                                              |
| -------------------- | -------------------------------------------------------------------------------- |
| Custom domain        | `endpoint.distribution`, `endpoint.httpApi` or `endpoint.restApi`                |
| WAF                  | `endpoint.distribution` (web ACL) or the REST API stage (`CfnWebACLAssociation`) |
| Throttling, API keys | The REST API stage and usage plans                                               |
| Access logging       | The API stage or the distribution; the Lambda writes its own ECS records anyway  |
| Alarms               | `endpoint.handler.metricErrors()`, and the front door's own metrics              |
