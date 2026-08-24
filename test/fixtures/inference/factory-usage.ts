import type dictionary from './factory-dictionary.js';

declare function getDictionary(): typeof dictionary;

getDictionary().usedThroughFactory;
