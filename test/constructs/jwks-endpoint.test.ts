import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PriceClass } from 'aws-cdk-lib/aws-cloudfront';
import {
  InterfaceVpcEndpoint,
  InterfaceVpcEndpointAwsService,
  SecurityGroup,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { JwksEndpoint, JwksExposure, JwksSource, type JwksEndpointProps } from '../../src/constructs';

const ENV = { region: 'us-east-1', account: '123456789012' };

/** A stack with a secret and a customer-key-encrypted parameter source, and the endpoint. */
function synth(
  props: Partial<JwksEndpointProps> = {},
  configure?: (stack: Stack) => JwksEndpointProps['sources'],
) {
  const stack = new Stack(undefined, 'TestStack', { env: ENV });
  const secret = new Secret(stack, 'Secret');
  const sources = configure?.(stack) ?? [
    JwksSource.fromSecret(secret),
    JwksSource.fromParameter('/app/enc-jwks'),
  ];
  const endpoint = new JwksEndpoint(stack, 'Endpoint', { sources, ...props });
  return { stack, secret, endpoint, template: Template.fromStack(stack) };
}

describe('the Lambda', () => {
  test('is a Node 24 arm64 function with the endpoint configuration in its environment', () => {
    const { stack, secret, template } = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      MemorySize: 128,
      Timeout: 10,
      LoggingConfig: { LogFormat: 'Text', LogGroup: { Ref: Match.stringLikeRegexp('HandlerLogGroup') } },
      Environment: {
        Variables: {
          JWKS_SOURCES: stack.resolve(
            stack.toJsonString([
              { type: 'secret', id: secret.secretArn },
              { type: 'parameter', name: '/app/enc-jwks' },
            ]),
          ),
          JWKS_PATH: '/.well-known/jwks.json',
          JWKS_CACHE_SECONDS: '300',
          JWKS_LOG_REQUESTS: 'true',
          JWKS_LOG_CLIENT_DETAILS: 'true',
        },
      },
    });
  });

  test('keeps its logs for a year, retained, and may write only to its own log group', () => {
    const { template } = synth();
    template.hasResource('AWS::Logs::LogGroup', {
      Properties: { RetentionInDays: 365 },
      DeletionPolicy: 'Retain',
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: ['logs:CreateLogStream', 'logs:PutLogEvents'] }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::IAM::Role', { ManagedPolicyArns: Match.absent() });
  });

  test('can read the sources, and nothing else', () => {
    const { template } = synth();
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) =>
        (policy as { Properties: { PolicyDocument: { Statement: { Action: unknown }[] } } }).Properties
          .PolicyDocument.Statement,
    );
    const actions = statements.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    );
    expect(new Set(actions)).toEqual(
      new Set([
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'ssm:GetParameter',
      ]),
    );
  });

  test('reads the parameter by its ARN, and decrypts with the key it is given', () => {
    const { template } = synth({}, (stack) => [
      JwksSource.fromParameter('/app/enc-jwks', { encryptionKey: new Key(stack, 'Key') }),
    ]);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'ssm:GetParameter', Resource: Match.anyValue() }),
          Match.objectLike({ Action: 'kms:Decrypt' }),
        ]),
      },
    });
    expect(JSON.stringify(template.toJSON())).toContain('parameter/app/enc-jwks');
  });

  test('applies the optional props', () => {
    const stack = new Stack(undefined, 'TestStack', { env: ENV });
    const vpc = new Vpc(stack, 'Vpc');
    const securityGroup = new SecurityGroup(stack, 'Sg', { vpc });
    new JwksEndpoint(stack, 'Endpoint', {
      sources: [JwksSource.fromParameter('/p')],
      path: '/jwks',
      cacheTtl: Duration.seconds(0),
      logRequests: false,
      logClientDetails: false,
      lambdaProps: { memorySize: 256, vpc, securityGroups: [securityGroup] },
      logGroupProps: { retention: RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 256,
      VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
      Environment: {
        Variables: Match.objectLike({
          JWKS_PATH: '/jwks',
          JWKS_CACHE_SECONDS: '0',
          JWKS_LOG_REQUESTS: 'false',
          JWKS_LOG_CLIENT_DETAILS: 'false',
        }),
      },
    });
    template.hasResource('AWS::Logs::LogGroup', {
      Properties: { RetentionInDays: 30 },
      DeletionPolicy: 'Delete',
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('AWSLambdaVPCAccessExecutionRole')])],
        }),
      ]),
    });
  });
});

describe('exposures', () => {
  test('is a public Function URL by default, and nothing else', () => {
    const { endpoint, template } = synth();
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
    template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    expect(endpoint.functionUrl).toBeDefined();
    expect(endpoint.restApi).toBeUndefined();
    expect(endpoint.url).toMatch(/\.well-known\/jwks\.json$/);
  });

  test('the Function URL of the default exposure is joined to the path with one slash', () => {
    // A Function URL ends with "/" already, so a path that starts with "/" would double it.
    const { stack, endpoint } = synth();
    const resolved = JSON.stringify(stack.resolve(endpoint.url));
    expect(resolved).toContain('"Fn::GetAtt"');
    expect(resolved).toContain('".well-known/jwks.json"');
    expect(resolved).not.toContain('"/.well-known/jwks.json"');
  });

  test('a custom path is joined with one slash too', () => {
    const { stack, endpoint } = synth({ path: '/keys/jwks.json' });
    const resolved = JSON.stringify(stack.resolve(endpoint.url));
    expect(resolved).toContain('"keys/jwks.json"');
    expect(resolved).not.toContain('"/keys/jwks.json"');
  });

  test('cloudFront: a distribution over an IAM-authenticated Function URL with an origin access control', () => {
    const { endpoint, template } = synth({ exposure: JwksExposure.cloudFront() });
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 'lambda',
        SigningBehavior: 'always',
      }),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        PriceClass: 'PriceClass_100',
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'https-only',
          AllowedMethods: ['GET', 'HEAD'],
        }),
      }),
    });
    // The policy honours the origin's Cache-Control.
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({ DefaultTTL: 0, MinTTL: 0, MaxTTL: 86400 }),
    });
    // CloudFront may invoke the URL, and the function through it; no one else. A function
    // URL needs both actions; aws-cdk-lib 2.273.0 grants both (aws/aws-cdk#35919).
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Principal: 'cloudfront.amazonaws.com',
      Action: 'lambda:InvokeFunctionUrl',
      SourceArn: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Principal: 'cloudfront.amazonaws.com',
      Action: 'lambda:InvokeFunction',
      InvokedViaFunctionUrl: true,
      SourceArn: Match.anyValue(),
    });
    expect(endpoint.distribution).toBeDefined();
    expect(endpoint.url).toMatch(/^https:\/\/.+\/\.well-known\/jwks\.json$/);
  });

  test('cloudFront: takes a price class', () => {
    const { template } = synth({
      exposure: JwksExposure.cloudFront({ priceClass: PriceClass.PRICE_CLASS_ALL }),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ PriceClass: 'PriceClass_All' }),
    });
  });

  test('httpApi: one GET route for the path', () => {
    const { endpoint, template } = synth({ exposure: JwksExposure.httpApi(), path: '/keys/jwks.json' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'GET /keys/jwks.json' });
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
    template.resourceCountIs('AWS::Lambda::Url', 0);
    expect(endpoint.httpApi).toBeDefined();
    expect(endpoint.url).toMatch(/\/keys\/jwks\.json$/);
  });

  test('restApi: one unauthenticated GET method on the path, regional', () => {
    const { endpoint, template } = synth({ exposure: JwksExposure.restApi() });
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: { Types: ['REGIONAL'] },
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '.well-known' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'jwks.json' });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'NONE',
      Integration: Match.objectLike({ Type: 'AWS_PROXY' }),
    });
    template.resourceCountIs('AWS::ApiGateway::Method', 1);
    expect(endpoint.restApi).toBeDefined();
  });

  describe('privateRestApi', () => {
    test('is private, allowed from the given VPC endpoints only', () => {
      const stack = new Stack(undefined, 'TestStack', { env: ENV });
      const vpc = new Vpc(stack, 'Vpc');
      const vpcEndpoint = new InterfaceVpcEndpoint(stack, 'ExecuteApi', {
        vpc,
        service: InterfaceVpcEndpointAwsService.APIGATEWAY,
      });
      const endpoint = new JwksEndpoint(stack, 'Endpoint', {
        sources: [JwksSource.fromParameter('/p')],
        exposure: JwksExposure.privateRestApi({ vpcEndpoints: [vpcEndpoint] }),
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        EndpointConfiguration: { Types: ['PRIVATE'], VpcEndpointIds: Match.anyValue() },
        Policy: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: { StringNotEquals: { 'aws:SourceVpce': Match.anyValue() } },
            }),
            Match.objectLike({ Effect: 'Allow', Action: 'execute-api:Invoke' }),
          ]),
        }),
      });
      expect(endpoint.restApi).toBeDefined();
    });

    test('needs at least one VPC endpoint', () => {
      expect(() => JwksExposure.privateRestApi({ vpcEndpoints: [] })).toThrow(/at least one VPC endpoint/);
    });
  });
});

test('exposes the Lambda, the role and the log group', () => {
  const { endpoint, stack } = synth();
  const role = new Role(stack, 'Other', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
  expect(endpoint.handler).toBeDefined();
  expect(endpoint.handlerRole).toBeDefined();
  expect(endpoint.logGroup).toBeDefined();
  expect(role).toBeDefined();
});

test('explains how to build a missing Lambda bundle', () => {
  // Spy on the module object itself, which the construct's named import reads from.
  jest.spyOn(require('node:fs') as typeof import('node:fs'), 'existsSync').mockReturnValue(false);
  try {
    expect(() => synth()).toThrow(/Endpoint Lambda bundle not found .* Run "npm run build:lambda"/);
  } finally {
    jest.restoreAllMocks();
  }
});

test.each([
  [{ sources: [] }, /at least one JwksSource/],
  [{ path: 'jwks.json' }, /absolute path/],
  [{ path: '/jwks/{id}' }, /absolute path/],
  [{ path: '/jwks?x=1' }, /absolute path/],
  [{ path: '/' }, /absolute path/],
  [{ path: '/a//b' }, /absolute path/],
  [{ cacheTtl: Duration.millis(1500) }, /whole number of seconds/],
  [{ lambdaProps: { memorySize: 64 } }, /memorySize must be an integer from 128 to 10240/],
  [{ lambdaProps: { memorySize: 256.5 } }, /memorySize must be an integer/],
])('rejects invalid props %j at synth time', (props, error) => {
  expect(() => synth(props as Partial<JwksEndpointProps>)).toThrow(error);
});

test('rejects an empty parameter name', () => {
  expect(() => JwksSource.fromParameter('')).toThrow(/must not be empty/);
});
