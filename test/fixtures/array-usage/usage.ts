import dictionary from './dictionary.js';

dictionary.calendar.weekDays.map((value) => value);
dictionary.calendar.weekDays.forEach((value) => void value);
dictionary.calendar.weekDays.reduce((result, value) => result + value);
dictionary.calendar.weekDays.reduceRight((result, value) => result + value);
dictionary.calendar.weekDays.filter(Boolean);
dictionary.calendar.weekDays.some(Boolean);
dictionary.calendar.weekDays.every(Boolean);
dictionary.calendar.weekDays.find(Boolean);
dictionary.calendar.weekDays.findIndex(Boolean);
dictionary.mutableValues.map((value) => value);

for (const value of dictionary.forOfValues) void value;

dictionary.staticValues[1];
const index: number = Date.now();
dictionary.dynamicValues[index];

dictionary.literalMap.map.label;
