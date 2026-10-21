import { describe, expect, it } from 'vitest'
import type { FunctionEnvVariable } from '@/api/generated/compute/FunctionEnvVariable'
import type { FunctionParam } from '@/api/generated/compute/FunctionParam'
import { detail, summary } from '../fixtures.test-support'
import { paramValue, userVariables, variableOrigin } from './environment-tab'

const variable = (fields: Partial<FunctionEnvVariable>): FunctionEnvVariable => ({
  key: 'KEY',
  value: 'value',
  secret: false,
  source: 'dotEnv',
  file: 'env',
  fileName: '.env',
  ...fields,
})

const param = (fields: Partial<FunctionParam>): FunctionParam => ({
  name: 'BATCH',
  type: 'int',
  label: null,
  default: '50',
  description: null,
  value: '50',
  secret: false,
  file: null,
  unresolved: true,
  ...fields,
})

describe('the Environment tab', () => {
  it('lists the defaults params take beside the env file values, marked as defaults', () => {
    const environment = detail(summary('api'), {
      environment: {
        files: ['.env'],
        variables: [
          variable({ key: 'GREETING', value: 'hello' }),
          variable({
            key: 'BATCH',
            value: '50',
            source: 'paramDefault',
            file: null,
            fileName: null,
          }),
          variable({
            key: 'API_KEY',
            value: null,
            secret: true,
            source: 'secretLocal',
            file: 'secretLocal',
            fileName: '.secret.local',
          }),
          variable({
            key: 'FUNCTIONS_EMULATOR',
            value: 'true',
            source: 'emulator',
            file: null,
            fileName: null,
          }),
        ],
        inherited: 3,
        editable: true,
      },
    }).environment
    const listed = userVariables(environment)
    expect(listed.map((entry) => entry.key)).toEqual(['GREETING', 'BATCH', 'API_KEY'])
    expect(listed.map(variableOrigin)).toEqual(['.env', 'default', '.secret.local'])
  })

  it('says where a param value comes from, as the variable list does', () => {
    expect(paramValue(param({}))).toEqual({ value: '50', from: 'default' })
    expect(paramValue(param({ value: '25', file: '.env.local', unresolved: false }))).toEqual({
      value: '25',
      from: '.env.local',
    })
    // Nothing resolves it: no value to show.
    expect(paramValue(param({ default: null, value: null }))).toBeNull()
    expect(paramValue(param({ secret: true, value: null, file: '.secret.local' }))).toBeNull()
  })
})
