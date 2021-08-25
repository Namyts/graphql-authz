import { execute, ExecutionArgs, ExecutionResult } from 'graphql';

import { completeConfig, IAuthZConfig } from './config';
import { getFilteredDocument, getFragmentDefinitions } from './graphql-utils';
import { cleanupResult } from './result-cleaner';
import { executePostExecRules } from './rule-executor';
import { compileRules } from './rules-compiler';
import { addSelectionSetsToDocument } from './visit-selection-set';

type ExecuteFn = typeof execute;

export function wrapExecuteFn(
  executeFn: ExecuteFn,
  config: IAuthZConfig
): (args: ExecutionArgs) => ReturnType<ExecuteFn> {
  const { rules, authSchema, directiveName, authSchemaKey, processError } =
    completeConfig(config);

  return async function executeWrapper(
    args: ExecutionArgs
  ): Promise<ExecutionResult> {
    const variables = args.variableValues || {};
    const filteredDocument = getFilteredDocument(
      args.document,
      args.operationName
    );
    const compiledRules = compileRules({
      document: filteredDocument,
      schema: args.schema,
      rules,
      variables,
      directiveName,
      authSchemaKey,
      authSchema
    });

    const fullDocument = addSelectionSetsToDocument(
      filteredDocument,
      compiledRules,
      args.schema,
      variables
    );

    try {
      await Promise.all(
        compiledRules.preExecutionRules.map(rule =>
          rule.execute(args.contextValue, rule.config.fieldArgs)
        )
      );
    } catch (error) {
      processError(error);
    }

    const executionResult = await executeFn({
      ...args,
      document: fullDocument
    });

    try {
      if (executionResult.data) {
        const fragmentDefinitions = getFragmentDefinitions(filteredDocument);

        const executionPromises = executePostExecRules({
          context: args.contextValue,
          schema: args.schema,
          resultData: executionResult.data,
          document: filteredDocument,
          rules: compiledRules,
          fragmentDefinitions,
          variables
        });

        const cleanResult = cleanupResult(
          filteredDocument,
          args.schema,
          fragmentDefinitions,
          variables,
          executionResult.data
        );

        await Promise.all(executionPromises);
        return {
          ...executionResult,
          data: cleanResult
        };
      }
      return executionResult;
    } catch (error) {
      processError(error);
    }

    throw new Error(
      'Something went wrong. processError function must throw an error'
    );
  };
}