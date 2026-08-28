import Ajv2020 from "ajv/dist/2020";
import type { ErrorObject } from "ajv";
import canonicalSchema from "../schemas/canonical.schema.json";
import type { CanonicalProject } from "../types/canonical.types";

export type ValidationResult = { valid: true; errors: [] } | { valid: false; errors: string[] };

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(canonicalSchema);

function pathWithProperty(path: string, property: string): string {
  const escapedProperty = property.replace(/~/g, "~0").replace(/\//g, "~1");
  return `${path === "/" ? "" : path}/${escapedProperty}`;
}

function formatSchemaError(error: ErrorObject): string {
  const path = error.instancePath || "/";
  const params = error.params as Record<string, unknown>;

  if (error.keyword === "required" && typeof params.missingProperty === "string") {
    return `${pathWithProperty(path, params.missingProperty)} is required`;
  }

  if (error.keyword === "additionalProperties" && typeof params.additionalProperty === "string") {
    return `${pathWithProperty(path, params.additionalProperty)} is not allowed`;
  }

  if (error.keyword === "propertyNames" && typeof params.propertyName === "string") {
    return `${pathWithProperty(path, params.propertyName)} has an invalid property name`;
  }

  return `${path} ${error.message ?? "is invalid"}`;
}

function validateCrossFieldRules(project: CanonicalProject): string[] {
  const errors: string[] = [];
  const circuitIds = new Set(Object.keys(project.circuits));
  const orderedTabs = new Set<string>();

  if (!circuitIds.has(project.projectMetadata.focussedCircuit)) {
    errors.push(`/projectMetadata/focussedCircuit refers to an unknown circuit`);
  }

  for (const [index, circuitId] of project.projectMetadata.orderedTabs.entries()) {
    const path = `/projectMetadata/orderedTabs/${index}`;
    if (!circuitIds.has(circuitId)) {
      errors.push(`${path} refers to an unknown circuit "${circuitId}"`);
    }
    orderedTabs.add(circuitId);
  }

  for (const circuitId of circuitIds) {
    if (!orderedTabs.has(circuitId)) {
      errors.push(`/projectMetadata/orderedTabs is missing circuit "${circuitId}"`);
    }
  }

  for (const [circuitId, scope] of Object.entries(project.circuits)) {
    const componentIds = new Set<string>();
    const netIds = new Set<string>();

    for (const component of scope.netlist.components) {
      if (componentIds.has(component.id)) {
        errors.push(`/circuits/${circuitId}/netlist/components has duplicate ID "${component.id}"`);
      }
      componentIds.add(component.id);
    }

    for (const net of scope.netlist.nets) {
      if (netIds.has(net.id)) {
        errors.push(`/circuits/${circuitId}/netlist/nets has duplicate ID "${net.id}"`);
      }
      netIds.add(net.id);
    }

    const layout = scope.layout;
    if (layout) {
      for (const componentId of Object.keys(layout)) {
        if (
          componentId === "intermediateNodes" ||
          componentId === "annotations" ||
          componentId === "subcircuitSymbol"
        ) {
          continue;
        }
        if (!componentIds.has(componentId)) {
          errors.push(
            `/circuits/${circuitId}/layout/${componentId} refers to an unknown component`,
          );
        }
      }

      for (const netId of Object.keys(layout.intermediateNodes ?? {})) {
        if (!netIds.has(netId)) {
          errors.push(
            `/circuits/${circuitId}/layout/intermediateNodes/${netId} refers to an unknown net`,
          );
        }
      }
    }

    for (const [index, subCircuitId] of scope.verilogMetadata.subCircuitScopeIds.entries()) {
      if (!circuitIds.has(subCircuitId)) {
        errors.push(
          `/circuits/${circuitId}/verilogMetadata/subCircuitScopeIds/${index} refers to an unknown circuit`,
        );
      }
    }
  }

  return errors;
}

export function validateCanonicalJson(value: unknown): ValidationResult {
  if (!validateSchema(value)) {
    return {
      valid: false,
      errors: (validateSchema.errors ?? []).slice(0, 20).map(formatSchemaError),
    };
  }

  // The schema validates the complete payload before cross-field checks read it.
  const project = value as CanonicalProject;
  const errors = validateCrossFieldRules(project).slice(0, 20);
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}
