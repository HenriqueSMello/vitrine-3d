# Vitrine 3D

Catálogo de tênis com visualização 3D e realidade aumentada (projeto acadêmico).

O modelo 3D de cada tênis é gerado **no navegador**, na hora, a partir de duas fotos laterais recortadas
(`img/<id>_lat.webp` e `img/<id>_med.webp`): a silhueta vira a geometria, a forma é "inflada" em escala real
(~30 cm) e as fotos viram textura. O `.glb` resultante é exibido com `<model-viewer>` e aberto em AR
(Quick Look no iPhone, WebXR/Scene Viewer no Android).

- `index.html` — catálogo e página de produto
- `gen3d.js` — gerador foto → GLB
- `tools/build_models.py` — recorte de fundo (rembg) e geração offline das imagens

Preços e estoque fictícios. Fotos usadas apenas para fins de estudo.
