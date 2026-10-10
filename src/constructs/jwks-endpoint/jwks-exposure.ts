import { Duration, Validations } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AuthorizationType, EndpointType, LambdaIntegration, RestApi } from 'aws-cdk-lib/aws-apigateway';
import {
  AllowedMethods,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  Distribution,
  PriceClass,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import type { IVpcEndpoint } from 'aws-cdk-lib/aws-ec2';
import { FunctionUrlAuthType, type FunctionUrl, type IFunction } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/** The resources a `JwksExposure` created, besides the Lambda. */
export interface JwksExposureResources {
  /** The URL of the JWKS. For a private API this is the API's `execute-api` URL, which only the VPC endpoints reach. */
  readonly url: string;
  /** The Function URL, for `functionUrl()` and `cloudFront()`. */
  readonly functionUrl?: FunctionUrl;
  /** The distribution, for `cloudFront()`. */
  readonly distribution?: Distribution;
  /** The HTTP API, for `httpApi()`. */
  readonly httpApi?: HttpApi;
  /** The REST API, for `restApi()` and `privateRestApi()`. */
  readonly restApi?: RestApi;
}

/** Options for `JwksExposure.cloudFront`. */
export interface CloudFrontExposureOptions {
  /**
   * The CloudFront price class.
   *
   * @default PriceClass.PRICE_CLASS_100
   */
  readonly priceClass?: PriceClass;
}

/** Options for `JwksExposure.privateRestApi`. */
export interface PrivateRestApiExposureOptions {
  /**
   * The `execute-api` interface VPC endpoints that may call the API. The
   * construct takes yours and does not create one. The resource policy allows
   * `GET` on the JWKS path from these endpoints only.
   */
  readonly vpcEndpoints: IVpcEndpoint[];
}

/**
 * How the JWKS endpoint is reached. Each factory builds the front door from
 * `aws-cdk-lib` constructs; the returned resources are exposed on the
 * `JwksEndpoint` so you can add a domain, a WAF or alarms.
 */
export abstract class JwksExposure {
  /** A public Lambda Function URL. Free, and public by design: a JWKS is public. */
  public static functionUrl(): JwksExposure {
    return new FunctionUrlExposure();
  }

  /**
   * A CloudFront distribution in front of a Function URL that only CloudFront
   * can call (IAM authentication with an origin access control). Needs
   * `aws-cdk-lib` 2.273.0 or later, which grants CloudFront both
   * `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` (aws/aws-cdk#35919);
   * earlier versions grant only the first, and CloudFront gets a 403.
   */
  public static cloudFront(options: CloudFrontExposureOptions = {}): JwksExposure {
    return new CloudFrontExposure(options);
  }

  /** A regional HTTP API with one `GET` route. */
  public static httpApi(): JwksExposure {
    return new HttpApiExposure();
  }

  /** A regional REST API with one `GET` method. */
  public static restApi(): JwksExposure {
    return new RestApiExposure();
  }

  /**
   * A private REST API, callable from the given VPC endpoints only. HTTP APIs
   * cannot be private, so this is a REST API.
   */
  public static privateRestApi(options: PrivateRestApiExposureOptions): JwksExposure {
    return new PrivateRestApiExposure(options);
  }

  /** Creates the front door for `handler`. Called by `JwksEndpoint`. */
  public abstract bind(scope: Construct, handler: IFunction, path: string): JwksExposureResources;
}

class FunctionUrlExposure extends JwksExposure {
  public bind(_scope: Construct, handler: IFunction, path: string): JwksExposureResources {
    const functionUrl = handler.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });
    // A Function URL always ends with "/", and it is a token at synthesis, so the
    // slash cannot be stripped from it: drop the one the path starts with instead.
    return { functionUrl, url: `${functionUrl.url}${path.slice(1)}` };
  }
}

class CloudFrontExposure extends JwksExposure {
  constructor(private readonly options: CloudFrontExposureOptions) {
    super();
  }

  public bind(scope: Construct, handler: IFunction, path: string): JwksExposureResources {
    const functionUrl = handler.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM });
    // The handler sets Cache-Control, so the TTL comes from the origin; nothing varies the response.
    const cachePolicy = new CachePolicy(scope, 'CachePolicy', {
      comment: 'Honours the Cache-Control of the JWKS endpoint',
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.days(1),
      headerBehavior: CacheHeaderBehavior.none(),
      queryStringBehavior: CacheQueryStringBehavior.none(),
      cookieBehavior: CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const distribution = new Distribution(scope, 'Distribution', {
      comment: 'JWKS endpoint',
      priceClass: this.options.priceClass ?? PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: FunctionUrlOrigin.withOriginAccessControl(functionUrl),
        viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy,
        compress: true,
      },
    });
    acknowledge(distribution, [
      [
        'AwsSolutions::AwsSolutions-CFR1',
        'A JWKS is public by design and fetched by servers; restricting it by country would break them.',
      ],
      [
        'AwsSolutions::AwsSolutions-CFR2',
        'Add a WAF web ACL to the distribution if you need one; it depends on your rules.',
      ],
      [
        'AwsSolutions::AwsSolutions-CFR3',
        'Access logging is left to you, since it needs a bucket in your logging account.',
      ],
      [
        'AwsSolutions::AwsSolutions-CFR4',
        'The default CloudFront certificate cannot set a minimum TLS version; attach your own certificate and domain to set one.',
      ],
    ]);
    return { functionUrl, distribution, url: `https://${distribution.distributionDomainName}${path}` };
  }
}

class HttpApiExposure extends JwksExposure {
  public bind(scope: Construct, handler: IFunction, path: string): JwksExposureResources {
    const httpApi = new HttpApi(scope, 'HttpApi', { description: 'JWKS endpoint' });
    const routes = httpApi.addRoutes({
      path,
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('Integration', handler),
    });
    for (const route of routes) {
      acknowledge(route, [
        ['AwsSolutions::AwsSolutions-APIG4', 'A JWKS is public by design, so the route has no authorizer.'],
      ]);
    }
    acknowledge(httpApi.defaultStage!, [
      [
        'AwsSolutions::AwsSolutions-APIG1',
        'Access logging is left to you; the endpoint writes its own ECS access records to its log group.',
      ],
    ]);
    return { httpApi, url: `${httpApi.apiEndpoint}${path}` };
  }
}

/** The REST API methods are unauthenticated on purpose: a JWKS is public. */
function addJwksMethod(api: RestApi, handler: IFunction, path: string): void {
  const method = api.root
    .resourceForPath(path)
    .addMethod('GET', new LambdaIntegration(handler), { authorizationType: AuthorizationType.NONE });
  acknowledge(method, [
    ['AwsSolutions::AwsSolutions-APIG4', 'A JWKS is public by design, so the method has no authorizer.'],
    [
      'AwsSolutions::AwsSolutions-COG4',
      'A JWKS is public by design, so there is no Cognito user pool authorizer.',
    ],
  ]);
}

class RestApiExposure extends JwksExposure {
  public bind(scope: Construct, handler: IFunction, path: string): JwksExposureResources {
    const restApi = new RestApi(scope, 'RestApi', {
      description: 'JWKS endpoint',
      endpointTypes: [EndpointType.REGIONAL],
      cloudWatchRole: false,
    });
    addJwksMethod(restApi, handler, path);
    acknowledgeRestApi(restApi);
    return { restApi, url: restApi.urlForPath(path) };
  }
}

class PrivateRestApiExposure extends JwksExposure {
  constructor(private readonly options: PrivateRestApiExposureOptions) {
    super();
    if (options.vpcEndpoints.length === 0) {
      throw new Error('privateRestApi needs at least one VPC endpoint');
    }
  }

  public bind(scope: Construct, handler: IFunction, path: string): JwksExposureResources {
    const restApi = new RestApi(scope, 'RestApi', {
      description: 'JWKS endpoint (private)',
      endpointConfiguration: { types: [EndpointType.PRIVATE], vpcEndpoints: this.options.vpcEndpoints },
      cloudWatchRole: false,
    });
    addJwksMethod(restApi, handler, path);
    // Allows execute-api:Invoke from these VPC endpoints only, and denies every other caller.
    restApi.grantInvokeFromVpcEndpointsOnly(this.options.vpcEndpoints);
    acknowledgeRestApi(restApi);
    return { restApi, url: restApi.urlForPath(path) };
  }
}

function acknowledgeRestApi(restApi: RestApi): void {
  acknowledge(restApi, [
    [
      'AwsSolutions::AwsSolutions-APIG2',
      'The API has one GET method with no parameters or body, so there is nothing to validate.',
    ],
  ]);
  const stage = restApi.deploymentStage;
  acknowledge(stage, [
    [
      'AwsSolutions::AwsSolutions-APIG1',
      'Access logging is left to you; the endpoint writes its own ECS access records to its log group.',
    ],
    [
      'AwsSolutions::AwsSolutions-APIG3',
      'Associate a WAF web ACL with the stage if you need one; it depends on your rules.',
    ],
    [
      'AwsSolutions::AwsSolutions-APIG6',
      'Execution logging needs an account-level CloudWatch role; the endpoint writes its own ECS access records to its log group.',
    ],
  ]);
}

function acknowledge(
  construct: Construct,
  findings: readonly (readonly [id: string, reason: string])[],
): void {
  for (const [id, reason] of findings) {
    Validations.of(construct).acknowledge({ id, reason });
  }
}
