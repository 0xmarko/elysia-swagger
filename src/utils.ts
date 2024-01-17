/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { HTTPMethod, LocalHook } from 'elysia';

import { Kind, type TSchema } from '@sinclair/typebox';
import type { OpenAPIV3 } from 'openapi-types';

import deepClone from 'lodash.clonedeep';

export const toOpenAPIPath = (path: string) =>
  path
    .split('/')
    .map((x) => (x.startsWith(':') ? `{${x.slice(1, x.length)}}` : x))
    .join('/');

/**
 * Modified by @0xmarko.
 * Correctly set parameter properties for more complex schemas that use 'anyOf'.
 * Includes things like 't.Numeric()' or 't.Nullable(t.String())'.
 *
 * The fix places 'anyOf' into the 'schema' property, instead of placing
 * it into the root parameter object and leaving 'schema' empty.
 */
export const mapProperties = (
  name: string,
  inputSchema: TSchema | string | undefined,
  models: Record<string, TSchema>,
) => {
  if (!inputSchema) return [];

  let schema: TSchema | undefined;
  if (typeof inputSchema === 'string') {
    if (!(inputSchema in models))
      throw new Error(`Can't find model ${inputSchema}`);
    schema = models[inputSchema];
  } else {
    schema = inputSchema;
  }

  return Object.entries(schema.properties ?? []).map(([key, value]) => {
    const { type, anyOf, ...rest } = value as any;
    return {
      ...rest,
      schema: type ? { type } : { anyOf },
      in: name,
      name: key,
      required: schema?.required?.includes(key) ?? false,
    };
  });
};

const mapTypesResponse = (types: string[], schema: TSchema | string) => {
  const responses: Record<string, OpenAPIV3.MediaTypeObject> = {};

  for (const type of types)
    responses[type] = {
      schema:
        typeof schema === 'string'
          ? {
              $ref: `#/components/schemas/${schema}`,
            }
          : { ...(schema as any) },
    };

  return responses;
};

export const capitalize = (word: string) =>
  word.charAt(0).toUpperCase() + word.slice(1);

export const generateOperationId = (method: string, paths: string) => {
  let operationId = method.toLowerCase();

  if (paths === '/') return `${operationId}Index`;

  for (const path of paths.split('/')) {
    if (path.charCodeAt(0) === 123) {
      operationId += `By${capitalize(path.slice(1, -1))}`;
    } else {
      operationId += capitalize(path);
    }
  }

  return operationId;
};

export const registerSchemaPath = ({
  schema,
  path,
  method,
  hook,
  models,
}: {
  schema: Partial<OpenAPIV3.PathsObject>;
  contentType?: string | string[];
  path: string;
  method: HTTPMethod;
  hook?: LocalHook<any, any>;
  models: Record<string, TSchema>;
}) => {
  if (hook) hook = deepClone(hook);

  const contentType = hook?.type ?? [
    // Default to only json
    'application/json',
  ];

  path = toOpenAPIPath(path);

  const contentTypes =
    typeof contentType === 'string'
      ? [contentType]
      : contentType ?? ['application/json'];

  const bodySchema = hook?.body;
  const paramsSchema = hook?.params;
  const headerSchema = hook?.headers;
  const querySchema = hook?.query;
  const userProvidedResponseSchema = hook?.response;
  const responseSchema: OpenAPIV3.ResponsesObject = {};

  /**
   * Modified by @0xmarko.
   * Added support for array response schemas.
   * Set description to 'OK' if not provided.
   *
   * See:
   * https://github.com/elysiajs/elysia-swagger/issues/8
   * https://github.com/elysiajs/elysia-swagger/issues/39
   * https://github.com/elysiajs/elysia-swagger/pull/20
   */
  const addToResponseSchema = (code: string, schema: TSchema | string) => {
    if (typeof schema === 'string') {
      if (!(schema in models)) return;
      responseSchema[code] = {
        description: 'OK',
        content: mapTypesResponse(contentTypes, schema),
      };
    } else {
      const ignore = ['Undefined', 'Null', 'Void'].includes(schema[Kind]);
      const { description, ...rest } = schema;
      responseSchema[code] = {
        description: description ?? 'OK',
        content: ignore ? undefined : mapTypesResponse(contentTypes, rest),
      };
    }
  };

  if (typeof userProvidedResponseSchema === 'object') {
    if (Kind in userProvidedResponseSchema) {
      addToResponseSchema('200', userProvidedResponseSchema);
    } else {
      for (const [code, value] of Object.entries(
        userProvidedResponseSchema as Record<string, TSchema | string>,
      )) {
        addToResponseSchema(code, value);
      }
    }
  } else if (typeof userProvidedResponseSchema === 'string') {
    addToResponseSchema('200', userProvidedResponseSchema);
  }

  const parameters = [
    ...mapProperties('header', headerSchema, models),
    ...mapProperties('path', paramsSchema, models),
    ...mapProperties('query', querySchema, models),
  ];

  /**
   * Modified by @0xmarko.
   * Reordered the properties of the OpenAPI operation object to
   * improve readability and consistency.
   *
   * New order: 'operationId', 'detail', 'parameters', 'requestBody', 'responses'.
   */
  schema[path] = {
    ...(schema[path] ? schema[path] : {}),
    [method.toLowerCase()]: {
      operationId:
        hook?.detail?.operationId ?? generateOperationId(method, path),
      ...hook?.detail,
      ...((headerSchema || paramsSchema || querySchema || bodySchema
        ? ({ parameters } as any)
        : {}) satisfies OpenAPIV3.ParameterObject),
      ...(bodySchema
        ? {
            requestBody: {
              content: mapTypesResponse(
                contentTypes,
                typeof bodySchema === 'string'
                  ? {
                      $ref: `#/components/schemas/${bodySchema}`,
                    }
                  : (bodySchema as any),
              ),
            },
          }
        : null),
      ...(responseSchema
        ? {
            responses: responseSchema,
          }
        : {}),
    } satisfies OpenAPIV3.OperationObject,
  };
};

export const filterPaths = (
  paths: Record<string, any>,
  {
    excludeStaticFile = true,
    exclude = [],
  }: {
    excludeStaticFile: boolean;
    exclude: (string | RegExp)[];
  },
) => {
  const newPaths: Record<string, any> = {};

  for (const [key, value] of Object.entries(paths))
    if (
      !exclude.some((x) => {
        if (typeof x === 'string') return key === x;

        return x.test(key);
      }) &&
      !key.includes('/swagger') &&
      !key.includes('*') &&
      (excludeStaticFile ? !key.includes('.') : true)
    ) {
      for (const [method] of Object.entries(value)) {
        const schema = value[method];

        if (key.includes('{')) {
          if (!schema.parameters) schema.parameters = [];

          schema.parameters = [
            ...key
              .split('/')
              .filter(
                (x) =>
                  x.startsWith('{') &&
                  !schema.parameters.find(
                    (params: Record<string, any>) =>
                      params.in === 'path' &&
                      params.name === x.slice(1, x.length - 1),
                  ),
              )
              .map((x) => ({
                schema: { type: 'string' },
                in: 'path',
                name: x.slice(1, x.length - 1),
                required: true,
              })),
            ...schema.parameters,
          ];
        }

        if (!schema.responses)
          schema.responses = {
            200: {},
          };
      }

      newPaths[key] = value;
    }

  return newPaths;
};
