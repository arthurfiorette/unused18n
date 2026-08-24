import fs from 'node:fs';
import path from 'node:path';

const options = parseArguments(process.argv.slice(2));
const outputDirectory = path.resolve(options.output);
fs.mkdirSync(outputDirectory, { recursive: true });

const arrayCount = Math.min(options.arrays, options.keys);
const arrayLeafCount = Math.min(options.keys, arrayCount * 4);
const objectLeafCount = options.keys - arrayLeafCount;
const root = new Map();
const objectPaths = [];
const width = Math.max(1, Math.ceil(objectLeafCount ** (1 / options.depth)));

for (let index = 0; index < objectLeafCount; index += 1) {
  const segments = [];
  let cursor = Math.floor(index / width);
  for (let level = 0; level < options.depth - 1; level += 1) {
    segments.unshift(`group_${level}_${cursor % width}`);
    cursor = Math.floor(cursor / width);
  }
  segments.push(`key_${index}`);
  insert(root, segments, `Value ${index}`);
  objectPaths.push(segments);
}

const arrays = Array.from({ length: arrayCount }, () => []);
for (let index = 0; index < arrayLeafCount; index += 1) {
  arrays[index % arrayCount]?.push(`Array value ${index}`);
}
for (const [index, values] of arrays.entries()) root.set(`array_${index}`, values);

const unusedCount = Math.floor(objectLeafCount * options.unusedRatio);
const usedPaths = objectPaths.slice(0, objectLeafCount - unusedCount);
const usage = [
  "import dictionary from './dictionary.js';",
  '',
  ...usedPaths.map((segments) => `void dictionary.${segments.join('.')};`),
  ...arrays.map((_, index) => `dictionary.array_${index}.forEach((value) => void value);`),
  ''
].join('\n');

fs.writeFileSync(
  path.join(outputDirectory, 'dictionary.ts'),
  `export default ${serialize(root)} as const;\n`
);
fs.writeFileSync(path.join(outputDirectory, 'usage.ts'), usage);
fs.writeFileSync(
  path.join(outputDirectory, 'tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext'
      },
      include: ['*.ts']
    },
    null,
    2
  )}\n`
);
// The marker lets the end-to-end runner distinguish generated data from a real dictionary.
fs.writeFileSync(path.join(outputDirectory, '.unused18n-benchmark-disposable'), 'generated\n');

function insert(rootNode, segments, value) {
  let node = rootNode;
  for (const segment of segments.slice(0, -1)) {
    let child = node.get(segment);
    if (!(child instanceof Map)) {
      child = new Map();
      node.set(segment, child);
    }
    node = child;
  }
  node.set(segments.at(-1), value);
}

function serialize(value, indentation = 0) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (!(value instanceof Map)) return JSON.stringify(value);
  if (value.size === 0) return '{}';
  const indent = '  '.repeat(indentation);
  const childIndent = '  '.repeat(indentation + 1);
  const properties = [...value].map(
    ([key, child]) => `${childIndent}${key}: ${serialize(child, indentation + 1)}`
  );
  return `{\n${properties.join(',\n')}\n${indent}}`;
}

function parseArguments(arguments_) {
  const values = Object.create(null);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--') continue;
    if (!argument?.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const [rawName, inlineValue] = argument.slice(2).split('=', 2);
    const value = inlineValue ?? arguments_[++index];
    if (value === undefined) throw new Error(`Missing value for --${rawName}`);
    values[rawName] = value;
  }

  const keys = positiveInteger(values.keys, '--keys');
  const depth = positiveInteger(values.depth ?? '3', '--depth');
  const arrays = nonNegativeInteger(values.arrays ?? '0', '--arrays');
  const unusedRatio = Number(values['unused-ratio'] ?? '0.5');
  if (!(unusedRatio >= 0 && unusedRatio <= 1)) {
    throw new Error('--unused-ratio must be between 0 and 1');
  }
  if (!values.output) throw new Error('--output <directory> is required');
  return { output: values.output, keys, depth, arrays, unusedRatio };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`${name} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return number;
}
