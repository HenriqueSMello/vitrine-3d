// Vitrine 3D — dimensões aproximadas dos tênis (réplica em escala real)
// Fonte: medições de laboratório RunRepeat (corte do tênis ao meio, tamanho US 9 masculino ≈ BR 41).
// "interno" = comprimento interno; o comprimento externo é estimado em interno + 25 mm (biqueira + contraforte + borda do solado).
// Por numeração: cada número BR (ponto de Paris) = 2/3 cm = 6,67 mm de comprimento; largura e altura escalam na mesma proporção.
export const REF_BR = 41;
export const DIMS = {
  nb550:  { interno: 268.4, larguraAntepe: 102.0, larguraCalcanhar: 78.1, alturaSolaCalcanhar: 33.7, fonte: 'RunRepeat · New Balance 550' },
  aj1:    { interno: 272.0, larguraAntepe: 110.2, larguraCalcanhar: 82.5, alturaSolaCalcanhar: 22.9, fonte: 'RunRepeat · Air Jordan 1 Low' },
  af1w:   { interno: 271.0, larguraAntepe: null,  larguraCalcanhar: null, alturaSolaCalcanhar: 31.7, fonte: 'RunRepeat · Nike Air Force 1 07' },
  dunk:   { interno: 268.9, larguraAntepe: null,  larguraCalcanhar: null, alturaSolaCalcanhar: 23.1, fonte: 'RunRepeat · Nike Dunk Low' },
  nb1906: { interno: 272.0, larguraAntepe: null,  larguraCalcanhar: null, alturaSolaCalcanhar: 37.1, fonte: 'RunRepeat · NB 1906R (comprimento interno = média do laboratório)' },
};
/** comprimento externo aproximado (metros) do modelo `id` na numeração BR `size` */
export function lengthM(id, size = REF_BR) {
  const d = DIMS[id] || DIMS.nb550;
  return (d.interno + 25 + (size - REF_BR) * 6.67) / 1000;
}
export const scaleFor = (id, size) => lengthM(id, size) / lengthM(id, REF_BR);
