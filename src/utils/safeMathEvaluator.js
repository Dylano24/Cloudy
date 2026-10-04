/**
 * SAFE MATH EVALUATOR — replaces dangerous Function() constructor
 * Uses RPN (Reverse Polish Notation) instead of eval-like patterns
 * NO code injection possible
 */

function validateExpression(expr) {
  // Allow only numbers, operators, parentheses, spaces, decimals
  if (!/^[0-9+\-*/.() \t]+$/.test(expr)) {
    throw new Error('Invalid character in expression');
  }
  // Prevent deeply nested parentheses (DoS attack)
  let depth = 0;
  for (const char of expr) {
    if (char === '(') {
      depth++;
      if (depth > 20) throw new Error('Expression too deeply nested');
    } else if (char === ')') {
      depth--;
      if (depth < 0) throw new Error('Mismatched parentheses');
    }
  }
  if (depth !== 0) throw new Error('Mismatched parentheses');
  return true;
}

function tokenize(expr) {
  const tokens = [];
  const pattern = /(\d+\.?\d*|\+|\-|\*|\/|\(|\))/g;
  let match;
  while ((match = pattern.exec(expr)) !== null) {
    tokens.push(match[1]);
  }
  return tokens;
}

function precedence(op) {
  if (op === '+' || op === '-') return 1;
  if (op === '*' || op === '/') return 2;
  return 0;
}

function isOperator(token) {
  return ['+', '-', '*', '/'].includes(token);
}

function toRPN(tokens) {
  const output = [];
  const operators = [];

  for (const token of tokens) {
    if (!isNaN(Number(token))) {
      output.push(Number(token));
    } else if (token === '(') {
      operators.push(token);
    } else if (token === ')') {
      while (operators.length && operators[operators.length - 1] !== '(') {
        output.push(operators.pop());
      }
      if (!operators.length) throw new Error('Mismatched parentheses');
      operators.pop(); // Remove '('
    } else if (isOperator(token)) {
      while (
        operators.length &&
        operators[operators.length - 1] !== '(' &&
        precedence(operators[operators.length - 1]) >= precedence(token)
      ) {
        output.push(operators.pop());
      }
      operators.push(token);
    }
  }

  while (operators.length) {
    const op = operators.pop();
    if (op === '(' || op === ')') throw new Error('Mismatched parentheses');
    output.push(op);
  }

  return output;
}

function evaluateRPN(rpn) {
  const stack = [];

  for (const token of rpn) {
    if (typeof token === 'number') {
      stack.push(token);
    } else if (isOperator(token)) {
      if (stack.length < 2) throw new Error('Invalid expression');
      const b = stack.pop();
      const a = stack.pop();

      if (token === '+') stack.push(a + b);
      else if (token === '-') stack.push(a - b);
      else if (token === '*') stack.push(a * b);
      else if (token === '/') {
        if (b === 0) throw new Error('Division by zero');
        stack.push(a / b);
      }
    }
  }

  if (stack.length !== 1) throw new Error('Invalid expression');
  return stack[0];
}

/**
 * SAFE evaluation — zero code injection risk
 * @param {string} expr - Mathematical expression like "2+2*3"
 * @returns {number} - Result
 * @throws {Error} - If expression is invalid
 */
export function evaluateSafeMath(expr) {
  validateExpression(expr);
  const tokens = tokenize(expr);
  if (tokens.length === 0) throw new Error('Empty expression');
  const rpn = toRPN(tokens);
  return evaluateRPN(rpn);
}

// Backward compatibility with existing code
export function evaluateMathExpression(expr) {
  return evaluateSafeMath(expr);
}

