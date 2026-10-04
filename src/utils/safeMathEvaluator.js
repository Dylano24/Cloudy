/**
 * Safe math evaluator for Cloudy counting-game expressions.
 * Supports +, -, *, /, ^/**, decimals and parentheses without code generation.
 */

const MAX_EXPRESSION_LENGTH = 256;
const MAX_PARENTHESES_DEPTH = 20;

function normalizeExpression(expr) {
  const normalized = String(expr ?? '').trim().replace(/\^/g, '**');
  if (!normalized) throw new Error('Empty expression');
  if (normalized.length > MAX_EXPRESSION_LENGTH) throw new Error('Expression too long');
  if (!/^[0-9+\-*/.() \t]+$/.test(normalized)) {
    throw new Error('Invalid character in expression');
  }

  let depth = 0;
  for (const char of normalized) {
    if (char === '(') {
      depth += 1;
      if (depth > MAX_PARENTHESES_DEPTH) throw new Error('Expression too deeply nested');
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) throw new Error('Mismatched parentheses');
    }
  }
  if (depth !== 0) throw new Error('Mismatched parentheses');
  return normalized;
}

function tokenize(expression) {
  const tokens = [];

  for (let index = 0; index < expression.length;) {
    const char = expression[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/\d|\./.test(char)) {
      const start = index;
      let dots = 0;
      let digits = 0;

      while (index < expression.length && /[\d.]/.test(expression[index])) {
        if (expression[index] === '.') dots += 1;
        else digits += 1;
        if (dots > 1) throw new Error('Invalid number');
        index += 1;
      }

      if (digits === 0) throw new Error('Invalid number');
      const value = Number(expression.slice(start, index));
      if (!Number.isFinite(value)) throw new Error('Invalid number');
      tokens.push({ type: 'number', value });
      continue;
    }

    if (char === '*' && expression[index + 1] === '*') {
      tokens.push({ type: 'operator', value: '**' });
      index += 2;
      continue;
    }

    if ('+-*/'.includes(char)) {
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char });
      index += 1;
      continue;
    }

    throw new Error('Invalid expression');
  }

  return tokens;
}

function applyBinary(operator, left, right) {
  let value;
  if (operator === '+') value = left + right;
  else if (operator === '-') value = left - right;
  else if (operator === '*') value = left * right;
  else if (operator === '/') {
    if (right === 0) throw new Error('Division by zero');
    value = left / right;
  } else if (operator === '**') {
    value = left ** right;
  } else {
    throw new Error('Unsupported operator');
  }

  if (!Number.isFinite(value)) throw new Error('Non-finite result');
  return value;
}

function parseTokens(tokens) {
  let index = 0;

  const peek = () => tokens[index];
  const consume = () => tokens[index++];

  function parsePrimary() {
    const token = consume();
    if (!token) throw new Error('Unexpected end of expression');

    if (token.type === 'number') return token.value;

    if (token.type === 'paren' && token.value === '(') {
      const value = parseAddSub();
      const closing = consume();
      if (!closing || closing.type !== 'paren' || closing.value !== ')') {
        throw new Error('Mismatched parentheses');
      }
      return value;
    }

    throw new Error('Expected a number or parenthesis');
  }

  function parsePower() {
    const left = parsePrimary();
    const token = peek();
    if (token?.type === 'operator' && token.value === '**') {
      consume();
      return applyBinary('**', left, parseUnary());
    }
    return left;
  }

  function parseUnary() {
    const token = peek();
    if (token?.type === 'operator' && (token.value === '+' || token.value === '-')) {
      consume();
      const value = parseUnary();
      return token.value === '-' ? -value : value;
    }
    return parsePower();
  }

  function parseMulDiv() {
    let value = parseUnary();
    while (true) {
      const token = peek();
      if (token?.type !== 'operator' || (token.value !== '*' && token.value !== '/')) break;
      consume();
      value = applyBinary(token.value, value, parseUnary());
    }
    return value;
  }

  function parseAddSub() {
    let value = parseMulDiv();
    while (true) {
      const token = peek();
      if (token?.type !== 'operator' || (token.value !== '+' && token.value !== '-')) break;
      consume();
      value = applyBinary(token.value, value, parseMulDiv());
    }
    return value;
  }

  const result = parseAddSub();
  if (index !== tokens.length) throw new Error('Unexpected token');
  if (!Number.isFinite(result)) throw new Error('Non-finite result');
  return result;
}

export function evaluateSafeMath(expr) {
  return parseTokens(tokenize(normalizeExpression(expr)));
}

export function evaluateMathExpression(expr) {
  return evaluateSafeMath(expr);
}
