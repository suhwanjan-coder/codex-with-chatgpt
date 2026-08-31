import ts from "typescript";

const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/i,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
];
const SENSITIVE_NAME = /^(?:api[_-]?key|access[_-]?(?:key|token)|refresh[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd|auth(?:orization)?)$/i;
const ASSIGNMENT_PATTERN = /\b(?:api[_-]?key|access[_-]?(?:key|token)|refresh[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd|auth(?:orization)?)\b["']?\s*[:=]\s*([^\s,;]+)/gi;

function reject(): never { throw new Error("SNAPSHOT_CONTENT"); }

function isPlaceholder(value: string): boolean {
  const normalized = value.replace(/^['"`]+|['"`]+$/g, "").toLowerCase();
  return normalized === "" || /^(?:placeholder|example|sample|changeme|change-me|your[-_a-z]*|<[^>]+>|\$\{[^}]+\})$/.test(normalized);
}

function checkText(content: string): void {
  if (CREDENTIAL_PATTERNS.some(pattern => pattern.test(content))) reject();
  for (const assignment of content.matchAll(ASSIGNMENT_PATTERN)) {
    if (!isPlaceholder(assignment[1])) reject();
  }
}

function nameOf(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) return node.text.replace(/^#/, "");
  if (ts.isPropertyAccessExpression(node)) return nameOf(node.name);
  if (ts.isElementAccessExpression(node)) return nameOf(node.argumentExpression);
  if (ts.isComputedPropertyName(node)) return nameOf(node.expression);
  return undefined;
}

function checkValue(node: ts.Node): void {
  if (ts.isTypeNode(node)) return;
  if (ts.isConditionalExpression(node)) {
    checkValue(node.whenTrue);
    checkValue(node.whenFalse);
    return;
  }
  if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
    checkValue(node.expression);
    return;
  }
  if (ts.isCallExpression(node)) {
    checkValue(node.expression);
    const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
    for (const argument of node.arguments) {
      // Selector indices, randomness sizes and encoding names are not returned credential values.
      if (ts.isNumericLiteral(argument) && (method === "slice" || method === "substring" || method === "substr" || nameOf(node.expression) === "randomBytes")) continue;
      if (method === "toString" && ts.isStringLiteralLike(argument) && /^(?:hex|base64|base64url|utf8|utf-8|ascii|latin1|binary|ucs2|ucs-2|utf16le|utf-16le)$/.test(argument.text)) continue;
      checkValue(argument);
    }
    return;
  }
  if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    if (!isPlaceholder(node.text)) reject();
  } else if (ts.isNumericLiteral(node)) {
    reject();
  }
  ts.forEachChild(node, checkValue);
}

function checkSource(content: string, filename: string): void {
  const source = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
  // Broken code is a valid review input. Screen its full text before using any recovered AST.
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (!Array.isArray(diagnostics)) reject();
  if (diagnostics.length !== 0) checkText(content);
  const inspectedComments = new Set<number>();
  const comments = (node: ts.Node): void => {
    for (const range of [...(ts.getLeadingCommentRanges(content, node.getFullStart()) ?? []), ...(ts.getTrailingCommentRanges(content, node.getEnd()) ?? [])]) {
      if (!inspectedComments.has(range.pos)) {
        inspectedComments.add(range.pos);
        checkText(content.slice(range.pos, range.end));
      }
    }
    for (const child of node.getChildren(source)) comments(child);
  };
  comments(source);
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) checkText(node.text);
    let name: ts.Node | undefined;
    let value: ts.Node | undefined;
    if (ts.isBindingElement(node)) {
      name = node.name;
      value = node.initializer;
    } else if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)) {
      name = node.name;
      value = node.initializer;
    } else if (ts.isPropertyAssignment(node)) {
      name = node.name;
      value = node.initializer;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      name = node.left;
      value = node.right;
    } else if (ts.isJsxAttribute(node)) {
      name = node.name;
      value = node.initializer;
    }
    const keys = name ? [nameOf(name)] : [];
    if (ts.isBindingElement(node) && node.propertyName) keys.push(nameOf(node.propertyName));
    if (value && keys.some(key => key && SENSITIVE_NAME.test(key))) checkValue(value);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/** Screening is a guardrail, not proof of non-sensitivity; exact-byte operator review is still required. */
export function assertSafeReviewContent(content: string, filename = ""): void {
  if (content.includes("\0") || CREDENTIAL_PATTERNS.some(pattern => pattern.test(content))) reject();
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(filename)) {
    checkSource(content, filename);
    return;
  }
  checkText(content);
}
