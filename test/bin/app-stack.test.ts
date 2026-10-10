import { App, Duration } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AppStack } from '../../bin/app-stack';
import type { AppStackProps } from '../../bin/app-stack-props';

function synth(props?: AppStackProps) {
  const app = new App();
  const stack = new AppStack(app, 'JwksEndpointExampleApp', props);
  return { stack, template: Template.fromStack(stack) };
}

describe('by default', () => {
  test('keeps both key sets in free SSM parameters and serves them through the free Function URL', () => {
    const { stack, template } = synth();
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    template.resourceCountIs('Custom::JwksParameter', 2);
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          JWKS_SOURCES: stack.resolve(
            stack.toJsonString([
              { type: 'parameter', name: stack.sigJwksParameter!.parameterName },
              { type: 'parameter', name: stack.encJwksParameter.parameterName },
            ]),
          ),
          JWKS_CACHE_SECONDS: '0',
        }),
      },
    });
    template.hasOutput('JwksUrl', {});
    template.hasOutput('SigParameterName', {});
    template.hasOutput('EncParameterName', {});
  });

  test('destroys the parameters and the logs with the stack', () => {
    const { template } = synth();
    template.allResources('Custom::JwksParameter', { DeletionPolicy: 'Delete' });
    template.allResources('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete' });
  });
});

describe('with sigSource secret', () => {
  test('reads a secret and a parameter, which is the mix of backends', () => {
    const { stack, template } = synth({ sigSource: 'secret' });
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.allResources('AWS::SecretsManager::Secret', { DeletionPolicy: 'Delete' });
    template.resourceCountIs('Custom::JwksParameter', 1);
    expect(stack.sigJwksParameter).toBeUndefined();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          JWKS_SOURCES: stack.resolve(
            stack.toJsonString([
              { type: 'secret', id: stack.sigJwksSecret!.secret.secretArn },
              { type: 'parameter', name: stack.encJwksParameter.parameterName },
            ]),
          ),
        }),
      },
    });
    template.hasOutput('SigSecretArn', {});
  });
});

test.each([
  ['cloudFront', 'AWS::CloudFront::Distribution'],
  ['httpApi', 'AWS::ApiGatewayV2::Api'],
  ['restApi', 'AWS::ApiGateway::RestApi'],
] as const)('exposure %s creates its front door', (exposure, type) => {
  const { template } = synth({ exposure });
  template.resourceCountIs(type, 1);
});

test('exposure privateRestApi is private to the given VPC endpoint', () => {
  const { template } = synth({ exposure: 'privateRestApi', vpcEndpointId: 'vpce-0123456789abcdef0' });
  template.hasResourceProperties('AWS::ApiGateway::RestApi', {
    EndpointConfiguration: { Types: ['PRIVATE'], VpcEndpointIds: ['vpce-0123456789abcdef0'] },
  });
});

test('exposure privateRestApi needs a VPC endpoint', () => {
  expect(() => synth({ exposure: 'privateRestApi' })).toThrow(/needs vpcEndpointId/);
});

test('rejects an unknown exposure', () => {
  expect(() => synth({ exposure: 'carrierPigeon' as never })).toThrow(/Unknown exposure/);
});

test('passes the algorithms, cache TTL and VPC through', () => {
  const app = new App();
  const stack = new AppStack(app, 'JwksEndpointExampleApp', {
    env: { account: '123456789012', region: 'us-east-1' },
    sigAlgorithm: 'PS256',
    encAlgorithm: 'RSA-OAEP-256',
    cacheTtl: Duration.minutes(5),
    lambdaVpcId: 'vpc-12345',
  });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: Match.objectLike({ JWK_OPTIONS: Match.stringLikeRegexp('"algorithm":"PS256"') }),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: Match.objectLike({ JWK_OPTIONS: Match.stringLikeRegexp('"algorithm":"RSA-OAEP-256"') }),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ JWKS_CACHE_SECONDS: '300' }) },
    VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
  });
});
