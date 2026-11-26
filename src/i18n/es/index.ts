// Diccionario castellano: inglés (texto del código) → castellano. Un fichero por módulo para que se puedan editar por
// separado; aquí solo se juntan. Si una misma clave está en dos ficheros, gana el último de la lista.
import common from './common';
import menu from './menu';
import dashboard from './dashboard';
import collections from './collections';
import cashflow from './cashflow';
import openEntries from './openEntries';
import payments from './payments';
import banco from './banco';
import closing from './closing';
import inventory from './inventory';
import controlling from './controlling';
import royalties from './royalties';
import commercial from './commercial';
import amazon from './amazon';
import customs from './customs';
import ocr from './ocr';
import magazines from './magazines';
import documents from './documents';
import salesReturns from './salesReturns';
import edeka from './edeka';
import settings from './settings';
import server from './server';

const ES: Record<string, string> = {
  ...common, ...menu, ...dashboard, ...collections, ...cashflow, ...openEntries, ...payments, ...banco, ...closing,
  ...inventory, ...controlling, ...royalties, ...commercial, ...amazon, ...customs, ...ocr, ...magazines, ...documents, ...salesReturns, ...edeka,
  ...settings, ...server,
};
export default ES;
