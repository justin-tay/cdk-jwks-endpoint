import { Arn, ArnFormat, Stack } from 'aws-cdk-lib';
import { Grant, type IGrantable } from 'aws-cdk-lib/aws-iam';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

/** Options for a JWKS stored in an SSM parameter. */
export interface JwksParameterSourceOptions {
  /**
   * The KMS key that encrypts the `SecureString`. The endpoint's role is
   * granted decrypt on it.
   *
   * @default the AWS managed key `alias/aws/ssm`, which needs no grant
   */
  readonly encryptionKey?: IKey;
}

/**
 * Where a JWKS is stored. The JWKS is the `{"keys":[...]}` that
 * `cdk-jwks-secret` and `cdk-jwks-parameter` maintain; this package depends on
 * neither, so pass their `secret` or `parameterName`.
 */
export abstract class JwksSource {
  /** A JWKS in the secret string of a Secrets Manager secret. */
  public static fromSecret(secret: ISecret): JwksSource {
    return new SecretSource(secret);
  }

  /** A JWKS in an SSM parameter, read decrypted. */
  public static fromParameter(parameterName: string, options: JwksParameterSourceOptions = {}): JwksSource {
    return new ParameterSource(parameterName, options);
  }

  /**
   * What the Lambda reads the source with, as written to its environment. May
   * contain tokens. Called by `JwksEndpoint`.
   */
  public abstract toConfig(): Readonly<Record<string, string>>;

  /** Grants `grantee` read access to the source. Called by `JwksEndpoint`. */
  public abstract grantRead(scope: Construct, grantee: IGrantable): void;
}

class SecretSource extends JwksSource {
  constructor(private readonly secret: ISecret) {
    super();
  }

  public toConfig(): Readonly<Record<string, string>> {
    return { type: 'secret', id: this.secret.secretArn };
  }

  public grantRead(_scope: Construct, grantee: IGrantable): void {
    this.secret.grantRead(grantee);
  }
}

class ParameterSource extends JwksSource {
  constructor(
    private readonly parameterName: string,
    private readonly options: JwksParameterSourceOptions,
  ) {
    super();
    if (parameterName.length === 0) {
      throw new Error('The parameter name must not be empty');
    }
  }

  public toConfig(): Readonly<Record<string, string>> {
    return { type: 'parameter', name: this.parameterName };
  }

  public grantRead(scope: Construct, grantee: IGrantable): void {
    Grant.addToPrincipal({
      grantee,
      actions: ['ssm:GetParameter'],
      resourceArns: [
        Arn.format(
          {
            service: 'ssm',
            resource: 'parameter',
            // The ARN of /a/b is arn:...:parameter/a/b, and of a is arn:...:parameter/a.
            resourceName: this.parameterName.replace(/^\//, ''),
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          },
          Stack.of(scope),
        ),
      ],
    });
    this.options.encryptionKey?.grantDecrypt(grantee);
  }
}
