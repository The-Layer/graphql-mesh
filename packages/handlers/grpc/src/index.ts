import { MeshHandlerLibrary, YamlConfig } from '@graphql-mesh/types';
import { accessSync, constants } from 'fs';
import { GraphQLEnumTypeConfig } from 'graphql';
import { GraphQLBigInt } from 'graphql-scalars';
import { AnyNestedObject, Root, IParseOptions } from 'protobufjs';
import { isAbsolute, join } from 'path';
import { camelCase } from 'camel-case';
import { pascalCase } from 'pascal-case';
import { SchemaComposer } from 'graphql-compose';
import { withCancel } from '@graphql-mesh/utils';
import { loadObject, credentials } from 'grpc';
import { get } from 'lodash';
import { Readable } from 'stream';
import { promisify } from 'util';

const SCALARS = {
  int32: 'Int',
  int64: 'BigInt',
  float: 'Float',
  double: 'Float',
  string: 'String',
  bool: 'Boolean',
};

interface LoadOptions extends IParseOptions {
  includeDirs?: string[];
}

interface GrpcResponseStream<T = any> extends Readable {
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
  cancel(): void;
}

function addIncludePathResolver(root: Root, includePaths: string[]) {
  const originalResolvePath = root.resolvePath;
  root.resolvePath = (origin: string, target: string) => {
    if (isAbsolute(target)) {
      return target;
    }
    for (const directory of includePaths) {
      const fullPath: string = join(directory, target);
      try {
        accessSync(fullPath, constants.R_OK);
        return fullPath;
      } catch (err) {
        continue;
      }
    }
    const path = originalResolvePath(origin, target);
    if (path === null) {
      console.warn(`${target} not found in any of the include paths ${includePaths}`);
    }
    return path;
  };
}

const handler: MeshHandlerLibrary<YamlConfig.GrpcHandler> = {
  async getMeshSource({ config }) {
    if (!config) {
      throw new Error('Config not specified!');
    }

    config.requestTimeout = config.requestTimeout || 200000;

    const schemaComposer = new SchemaComposer();
    schemaComposer.add(GraphQLBigInt);
    schemaComposer.createObjectTC({
      name: 'ServerStatus',
      description: 'status of the server',
      fields: {
        status: {
          type: 'String',
          descripton: 'status string',
        },
      },
    });

    function getTypeName(typePath: string, isInput: boolean) {
      if (typePath in SCALARS) {
        return SCALARS[typePath];
      }
      let baseTypeName = pascalCase(
        typePath
          .replace(config.packageName + '.', '')
          .split('.')
          .join('_')
      );
      if (isInput && !schemaComposer.isEnumType(baseTypeName)) {
        baseTypeName += 'Input';
      }
      return baseTypeName;
    }

    const root = new Root();
    let fileName = config.protoFilePath;
    let options: LoadOptions = {};
    if (typeof config.protoFilePath === 'object' && config.protoFilePath.file) {
      fileName = config.protoFilePath.file;
      options = config.protoFilePath.load;
      if (options.includeDirs) {
        if (!Array.isArray(options.includeDirs)) {
          return Promise.reject(new Error('The includeDirs option must be an array'));
        }
        addIncludePathResolver(root, options.includeDirs);
      }
    }
    const protoDefinition = await root.load(fileName as string, options);
    protoDefinition.resolveAll();
    const grpcObject = loadObject(root);

    async function visit(nested: AnyNestedObject, name: string, currentPath: string) {
      if ('values' in nested) {
        let typeName = name;
        if (currentPath !== config.packageName) {
          typeName = pascalCase(currentPath.split('.').join('_') + '_' + typeName);
        }
        const enumTypeConfig: GraphQLEnumTypeConfig = {
          name: typeName,
          values: {},
        };
        for (const [key] of Object.entries(nested.values)) {
          enumTypeConfig.values[key] = {
            value: key,
          };
        }
        schemaComposer.createEnumTC(enumTypeConfig);
      } else if ('fields' in nested) {
        let typeName = name;
        if (currentPath !== config.packageName) {
          typeName = pascalCase(currentPath.split('.').join('_') + '_' + typeName);
        }
        const inputTC = schemaComposer.createInputTC({
          name: typeName + 'Input',
          fields: {},
        });
        const outputTC = schemaComposer.createObjectTC({
          name: typeName,
          fields: {},
        });
        await Promise.all(
          Object.keys(nested.fields).map(async fieldName => {
            const { type, rule } = nested.fields[fieldName];
            inputTC.addFields({
              [fieldName]: {
                type: () => {
                  const inputTypeName = getTypeName(type, true);
                  return rule === 'repeated' ? `[${inputTypeName}]` : inputTypeName;
                },
              },
            });
            outputTC.addFields({
              [fieldName]: {
                type: () => {
                  const typeName = getTypeName(type, false);
                  return rule === 'repeated' ? `[${typeName}]` : typeName;
                },
              },
            });
          })
        );
      } else if ('methods' in nested) {
        const ServiceClient: any = get(grpcObject, currentPath + '.' + name);
        const client = new ServiceClient(config.endpoint, credentials.createInsecure());
        const methods = nested.methods;
        await Promise.all(
          Object.keys(methods).map(async methodName => {
            const method = methods[methodName];
            let rootFieldName = methodName;
            if (name !== config.serviceName) {
              rootFieldName = camelCase(name + '_' + rootFieldName);
            }
            if (currentPath !== config.packageName) {
              rootFieldName = camelCase(currentPath.split('.').join('_') + '_' + rootFieldName);
            }
            const fieldConfig = {
              type: () => getTypeName(method.responseType, false),
              args: {
                input: {
                  type: () => getTypeName(method.requestType, true),
                  defaultValue: {},
                },
              },
            };
            if (method.responseStream) {
              const clientMethod: Function = (input: any) => {
                const responseStream = client[methodName](input) as GrpcResponseStream;
                return withCancel(responseStream, () => responseStream.cancel());
              };
              schemaComposer.Subscription.addFields({
                [rootFieldName]: {
                  ...fieldConfig,
                  subscribe: (__, args) => clientMethod(args.input),
                  resolve: (payload: any) => payload,
                },
              });
            } else {
              const clientMethod: Function = promisify(client[methodName].bind(client));
              const identifier = methodName.toLowerCase();
              const rootTC = identifier.startsWith('get') ? schemaComposer.Query : schemaComposer.Mutation;
              rootTC.addFields({
                [rootFieldName]: {
                  ...fieldConfig,
                  resolve: (_, args) => clientMethod(args.input),
                },
              });
            }
          })
        );
        let rootPingFieldName = 'ping';
        if (name !== config.serviceName) {
          rootPingFieldName = camelCase(name + '_' + rootPingFieldName);
        }
        if (currentPath !== config.packageName) {
          rootPingFieldName = camelCase(currentPath.split('.').join('_') + '_' + rootPingFieldName);
        }
        schemaComposer.Query.addFields({
          [rootPingFieldName]: {
            type: 'ServerStatus',
            resolve: () => ({ status: 'online' }),
          },
        });
      } else if ('nested' in nested) {
        await Promise.all(
          Object.keys(nested.nested).map(async key => {
            const currentNested = nested.nested[key];
            await visit(currentNested, key, currentPath ? currentPath + '.' + name : name);
          })
        );
      }
    }
    const rootNested = root.toJSON({
      keepComments: true,
    });
    await visit(rootNested, '', '');

    const schema = schemaComposer.buildSchema();

    return {
      schema,
    };
  },
};

export default handler;
