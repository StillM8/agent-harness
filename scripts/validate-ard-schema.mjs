import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, "..");
const defaultSchemaPath = join(
  repositoryRoot,
  "discover",
  "schema",
  "ard-ai-catalog-1.0.schema.json",
);
const defaultCatalogPath = join(
  repositoryRoot,
  ".well-known",
  "ai-catalog.json",
);

/**
 * Validates the subset of JSON Schema draft 2020-12 used by the canonical ARD
 * ai-catalog schema. The validator is intentionally dependency-free so release
 * verification remains hermetic and cannot silently depend on a transitive Ajv.
 */
export function validateJsonSchema(
  value,
  schema,
  rootSchema = schema,
  path = "$",
) {
  const errors = [];
  validateNode(value, schema, rootSchema, path, errors);
  return errors;
}

function validateNode(value, schema, rootSchema, path, errors) {
  if (!schema || typeof schema !== "object") return;

  if (typeof schema.$ref === "string") {
    const target = resolveRef(schema.$ref, rootSchema);
    if (!target) {
      errors.push(`${path}: unresolved schema reference ${schema.$ref}`);
      return;
    }
    validateNode(value, target, rootSchema, path, errors);
    return;
  }

  if (Array.isArray(schema.oneOf)) {
    const matching = schema.oneOf.filter((candidate) => {
      const candidateErrors = [];
      validateNode(value, candidate, rootSchema, path, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (matching.length !== 1) {
      errors.push(`${path}: expected exactly one oneOf branch to match`);
    }
  }

  if (schema.not) {
    const notErrors = [];
    validateNode(value, schema.not, rootSchema, path, notErrors);
    if (notErrors.length === 0)
      errors.push(`${path}: matched forbidden schema`);
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected type ${JSON.stringify(schema.type)}`);
    return;
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => Object.is(entry, value))
  ) {
    errors.push(`${path}: value is not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
    if (schema.format === "uri" && !isUri(value)) {
      errors.push(`${path}: expected URI`);
    }
    if (schema.format === "date-time" && !isDateTime(value)) {
      errors.push(`${path}: expected RFC3339 date-time`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: expected at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems) {
      const fingerprints = value.map((entry) => JSON.stringify(entry));
      if (new Set(fingerprints).size !== fingerprints.length) {
        errors.push(`${path}: expected unique items`);
      }
    }
    if (schema.items) {
      value.forEach((entry, index) =>
        validateNode(
          entry,
          schema.items,
          rootSchema,
          `${path}[${index}]`,
          errors,
        ),
      );
    }
  }

  if (isObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key))
        errors.push(`${path}: missing required property ${key}`);
    }

    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        validateNode(
          value[key],
          propertySchema,
          rootSchema,
          `${path}.${key}`,
          errors,
        );
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key))
          errors.push(`${path}: unexpected property ${key}`);
      }
    } else if (isObject(schema.additionalProperties)) {
      const known = new Set(Object.keys(properties));
      for (const [key, propertyValue] of Object.entries(value)) {
        if (!known.has(key)) {
          validateNode(
            propertyValue,
            schema.additionalProperties,
            rootSchema,
            `${path}.${key}`,
            errors,
          );
        }
      }
    }
  }
}

function resolveRef(ref, rootSchema) {
  if (!ref.startsWith("#/")) return null;
  return ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce(
      (current, segment) =>
        isObject(current) && Object.hasOwn(current, segment)
          ? current[segment]
          : null,
      rootSchema,
    );
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    switch (type) {
      case "null":
        return value === null;
      case "array":
        return Array.isArray(value);
      case "object":
        return isObject(value);
      case "integer":
        return Number.isInteger(value);
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "string":
      case "boolean":
        return typeof value === type;
      default:
        return true;
    }
  });
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUri(value) {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol);
  } catch {
    return /^[a-z][a-z0-9+.-]*:[^\s]+$/iu.test(value);
  }
}

function isDateTime(value) {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  );
}

export async function validateArdCatalogFile(
  catalogPath = defaultCatalogPath,
  schemaPath = defaultSchemaPath,
) {
  const [catalogRaw, schemaRaw] = await Promise.all([
    readFile(catalogPath, "utf8"),
    readFile(schemaPath, "utf8"),
  ]);
  const catalog = JSON.parse(catalogRaw);
  const schema = JSON.parse(schemaRaw);
  return validateJsonSchema(catalog, schema);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalogPath = process.argv[2]
    ? resolve(process.argv[2])
    : defaultCatalogPath;
  const errors = await validateArdCatalogFile(catalogPath);
  if (errors.length > 0) {
    console.error(`ARD schema validation failed (${errors.length} error(s)):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`ARD schema validation passed: ${catalogPath}`);
  }
}
