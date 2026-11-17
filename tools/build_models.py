"""Vitrine 3D - gera modelos GLB a partir das fotos laterais (lateral + medial).

Pipeline por produto:
 1. Remove o fundo das fotos _00 (lateral, bico para a esquerda) e _01 (medial, bico para a direita).
 2. Usa a silhueta lateral como geometria e "infla" a forma com transformada de distancia
    (superficie arredondada tipo almofada), frente = lateral, verso = medial.
 3. Monta um atlas de textura (lateral | medial) e exporta .glb em escala real (~30 cm).
Tambem gera recortes PNG/WebP com fundo transparente para o catalogo.
"""
import sys, os, json
import numpy as np
from PIL import Image
from scipy import ndimage
import trimesh
from rembg import remove, new_session

SRC = sys.argv[1]
OUT = sys.argv[2]
IDS = sys.argv[3].split(',')
os.makedirs(f'{OUT}/models', exist_ok=True)
os.makedirs(f'{OUT}/img', exist_ok=True)
sess = new_session('isnet-general-use')

LENGTH_M = 0.30   # comprimento real do tenis
HALF_W = 0.050    # meia-largura maxima (m)
GRID = 220        # resolucao da malha ao longo do comprimento


def cutout(path):
    im = Image.open(path).convert('RGB')
    o = remove(im, session=sess, post_process_mask=True)
    a = np.array(o)
    al = a[..., 3]
    al[al < 40] = 0
    ys, xs = np.where(al > 128)
    pad = 6
    box = (max(xs.min() - pad, 0), max(ys.min() - pad, 0), min(xs.max() + pad, a.shape[1]), min(ys.max() + pad, a.shape[0]))
    return Image.fromarray(a).crop(box)


def bleed(rgba):
    """Preenche pixels transparentes com a cor opaca mais proxima (evita bordas pretas na textura)."""
    a = np.array(rgba)
    opaque = a[..., 3] > 128
    _, (iy, ix) = ndimage.distance_transform_edt(~opaque, return_indices=True)
    rgb = a[..., :3][iy, ix]
    return Image.fromarray(rgb.astype(np.uint8), 'RGB')


def build(pid):
    lat = cutout(f'{SRC}/{pid}_00.jpg')
    med = cutout(f'{SRC}/{pid}_01.jpg')

    # recortes para o catalogo
    for k, im in (('lat', lat), ('med', med)):
        t = im.copy(); t.thumbnail((1400, 1400))
        t.save(f'{OUT}/img/{pid}_{k}.webp', quality=86, method=6)
    for n in ('03', '04'):
        c = cutout(f'{SRC}/{pid}_{n}.jpg'); c.thumbnail((1000, 1000))
        c.save(f'{OUT}/img/{pid}_{n}.webp', quality=84, method=6)

    # ---- atlas de textura 2048x1024: [lateral | medial] ----
    S = 1024
    atlas = Image.new('RGB', (2 * S, S))
    rects = []
    for i, im in enumerate((lat, med)):
        b = bleed(im)
        sc = min(S / b.width, S / b.height)
        w, h = int(b.width * sc), int(b.height * sc)
        b = b.resize((w, h), Image.LANCZOS)
        ox, oy = i * S + (S - w) // 2, (S - h) // 2
        big = b.resize((w + 8, h + 8)); atlas.paste(big, (ox - 4, oy - 4))
        atlas.paste(b, (ox, oy))
        rects.append((ox, oy, w, h))

    # ---- geometria a partir da silhueta lateral ----
    gw = GRID
    gh = int(round(GRID * lat.height / lat.width))
    m = np.array(lat.split()[3].resize((gw, gh), Image.BILINEAR)) > 128
    m = ndimage.binary_opening(m, iterations=1)
    m = ndimage.binary_fill_holes(m)
    lab, n = ndimage.label(m)
    if n > 1:
        sizes = ndimage.sum(m, lab, range(1, n + 1))
        m = lab == (np.argmax(sizes) + 1)

    d = ndimage.distance_transform_edt(m)
    D = max(gh * 0.22, 4)
    prof = np.sqrt(np.clip((d - 0.5) / D, 0, 1))  # 0 na borda -> 1 no interior

    px = LENGTH_M / gw
    xs = np.arange(gw) * px
    # largura ao longo do comprimento: calcanhar mais estreito, antepe mais largo
    tnorm = np.arange(gw) / (gw - 1)                    # 0 = bico, 1 = calcanhar
    width_curve = 0.82 + 0.18 * np.sin(np.clip((1 - tnorm) * 1.25, 0, 1) * np.pi / 2)
    width_curve *= np.where(tnorm > 0.8, 1 - (tnorm - 0.8) * 0.9, 1)
    # mais estreito em cima (colarinho/lingueta)
    hnorm = 1 - np.arange(gh) / (gh - 1)                # 0 = sola, 1 = topo
    height_curve = 1 - 0.28 * np.clip(hnorm - 0.35, 0, 1) / 0.65

    idx = -np.ones((gh, gw), int)
    ys_, xs_ = np.where(m)
    idx[ys_, xs_] = np.arange(len(ys_))
    nv = len(ys_)
    X = xs[xs_] - LENGTH_M / 2
    Y = (gh - 1 - ys_) * px
    Z = HALF_W * prof[ys_, xs_] * width_curve[xs_] * height_curve[ys_]

    # faces da grade (2 triangulos por celula com os 4 cantos dentro)
    a = idx[:-1, :-1]; b = idx[:-1, 1:]; c = idx[1:, :-1]; dd = idx[1:, 1:]
    ok = (a >= 0) & (b >= 0) & (c >= 0) & (dd >= 0)
    a, b, c, dd = a[ok], b[ok], c[ok], dd[ok]
    # imagem: y para baixo -> no mundo y para cima; frente (+z) precisa de ordem CCW vista de +z
    f_front = np.concatenate([np.stack([a, c, b], 1), np.stack([b, c, dd], 1)])
    f_back = f_front[:, [0, 2, 1]] + nv

    # UVs: frente -> lateral; verso -> medial (foto original com bico a direita => espelha x)
    un = xs_ / (gw - 1); vn = ys_ / (gh - 1)
    (lx, ly, lw, lh), (mx, my, mw, mh) = rects
    uv_f = np.stack([(lx + un * lw) / (2 * S), 1 - (ly + vn * lh) / S], 1)
    uv_b = np.stack([(mx + (1 - un) * mw) / (2 * S), 1 - (my + vn * mh) / S], 1)

    V = np.concatenate([np.stack([X, Y, Z], 1), np.stack([X, Y, -Z], 1)])
    UV = np.concatenate([uv_f, uv_b])
    F = np.concatenate([f_front, f_back])

    mat = trimesh.visual.material.PBRMaterial(
        baseColorTexture=atlas, metallicFactor=0.0, roughnessFactor=0.62, doubleSided=False)
    mesh = trimesh.Trimesh(V, F, visual=trimesh.visual.TextureVisuals(uv=UV, material=mat), process=False)
    # costura: une vertices coincidentes da borda para normais suaves
    mesh.merge_vertices(merge_tex=False, merge_norm=True)
    scene = trimesh.Scene(mesh)
    glb = scene.export(file_type='glb')
    with open(f'{OUT}/models/{pid}.glb', 'wb') as fh:
        fh.write(glb)
    atlas.save(f'{OUT}/models/{pid}_atlas.jpg', quality=88)
    return {'id': pid, 'tris': int(len(F)), 'kb': len(glb) // 1024, 'h_m': round(float(Y.max()), 3)}


if __name__ == '__main__':
    print(json.dumps([build(p) for p in IDS]))
