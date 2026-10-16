import sys; sys.path.insert(0, '.')
from lib import *

def drape():  # 01 single draped veil pinned at one point
    body = P('M50 8 C44 8 41 14 38 22 C31 42 18 60 12 88 C22 82 30 82 36 88 C41 83 46 82 50 86 C54 82 59 83 64 88 C70 82 78 82 88 88 C82 60 69 42 62 22 C59 14 56 8 50 8Z')
    fold = P('M50 30 C47 48 42 66 36 86 L40 86 C45 66 49 48 50 30Z')
    return SUB(body, fold)

def twin_petals():  # 02 two translucent veils crossing into a V, overlap knocked out
    a = lens(18, 10, 58, 90, .13, .13); b = lens(82, 10, 42, 90, .13, .13)
    return X(a, b)

def twin_sails():  # 03 two sails, straight inner edges, gap V
    a = P('M14 10 C14 40 30 70 50 92 L50 76 C42 56 30 30 24 10Z')
    b = P('M86 10 C86 40 70 70 50 92 L50 76 C58 56 70 30 76 10Z')
    a = P('M12 12 C10 44 28 72 49 92 C46 62 36 34 22 12Z')
    b = P('M88 12 C90 44 72 72 51 92 C54 62 64 34 78 12Z')
    return U(a, b)

def ribbon():  # 04 folded ribbon v, right arm passes in front
    L = stroke(P('M24 6 L52 94'), 18); R = stroke(P('M48 94 L76 6'), 18)
    clip = rect(0, 12, 100, 88)
    L, R = I(L, clip), I(R, clip)
    return U(SUB(L, grow(R, 2.6)), R)

def curtain():  # 05 curtain drawn aside inside a round window
    c = circ(50, 50, 42)
    swoop = P('M58 4 C50 30 36 46 40 58 C44 72 62 84 66 98 L120 98 L120 4Z')
    cur = SUB(c, swoop)
    win = SUB(ring(50, 50, 42, 3.6), cur)
    return U(cur, SUB(win, grow(cur, 3)))

def eclipse():  # 06 crescent with the hidden body as a fine ring
    cres = SUB(circ(50, 50, 42), circ(63, 44, 36))
    return U(cres, ring(50, 50, 42, 3.2))

def lenses():  # 07 nested lenses tangent at the base
    r = pathops.Path()
    for R_, t in ((42, 5), (31, 5), (20, 5)):
        r = U(r, ring(50, 92-R_, R_, t))
    return U(r, circ(50, 92-9, 9))

def v_fold():  # 08 lowercase v with a fold cut at the vertex
    L = poly((14, 22), (33, 22), (55, 82), (44, 82))
    R = poly((67, 22), (86, 22), (62, 82), (44, 82))
    R2 = poly((86, 22), (67, 22), (52, 64), (58, 82), (62, 82))
    return U(SUB(L, grow(R2, 2.6)), R2)

def y_in_v():  # 09 a veil hung from two points, parted: V outside, Y inside
    body = P('M10 14 C30 26 42 34 50 34 C58 34 70 26 90 14 C80 46 64 72 50 92 C36 72 20 46 10 14Z')
    slit = P('M47.6 34 L52.4 34 L52.4 76 L47.6 76Z')
    notch = P('M38 4 C44 22 48 30 50 34 C52 30 56 22 62 4Z')
    return SUB(body, slit, notch)

def seal():  # 10 seal with a folded flap pressed into it
    c = circ(50, 50, 42)
    chord = 38
    flap = P('M15.4 38 C24 58 38 70 50 70 C62 70 76 58 84.6 38Z')
    return U(SUB(c, grow(flap, 3), rect(0, 0, 100, chord)), flap)

def drop():  # 11 a drop of liquidity under a sagging veil line
    d = P('M50 6 C58 22 82 40 82 62 C82 80 68 94 50 94 C32 94 18 80 18 62 C18 40 42 22 50 6Z')
    gap = stroke(P('M8 46 C26 64 74 64 92 46'), 4.4)
    return SUB(d, gap)

def calligraphic():  # 12 twisting ribbon v: arms swap width through the vertex
    L = P('M12 12 L34 12 C38 40 46 70 51 90 C42 70 24 40 12 12Z')
    R = P('M88 12 L83 12 C74 40 60 68 51 90 C62 70 78 40 88 12Z')
    return U(L, R)

def sash():  # 13 a sphere wrapped in a sash of veil
    c = circ(50, 50, 40)
    band = P('M2 74 C30 56 60 30 98 24 L98 40 C64 44 36 66 8 88Z')
    inner = SUB(I(band, circ(50, 50, 52)), pathops.Path())
    return U(SUB(c, grow(band, 3.2)), I(band, rect(0, 0, 100, 100)))

def petal_v():  # 14 one petal folded into a V: front leaf + back leaf
    front = P('M50 92 C42 66 46 30 80 10 C78 44 66 70 50 92Z')
    back = P('M50 92 C34 72 20 44 20 12 C34 26 44 48 48 74Z')
    return U(SUB(back, grow(front, 2.8)), front)

SK = [('01', 'Drape', drape), ('02', 'Twin veils', twin_petals), ('03', 'Sails', twin_sails), ('04', 'Folded ribbon', ribbon),
      ('05', 'Curtain', curtain), ('06', 'Veiled eclipse', eclipse), ('07', 'Lenses', lenses), ('08', 'v fold cut', v_fold),
      ('09', 'Y in V', y_in_v), ('10', 'Seal', seal), ('11', 'Veiled drop', drop), ('12', 'Twist', calligraphic),
      ('13', 'Sash', sash), ('14', 'Folded leaf', petal_v)]

def occult():  # 15 one disc veils another; only a crescent of the back disc shows
    front = circ(56, 52, 34); back = circ(44, 48, 38)
    return U(SUB(back, grow(front, 3.6)), front)

def orb_v():  # 16 an orb with a veil whose hem dips to a point (V)
    c = circ(50, 50, 42)
    hem = stroke(P('M4 40 C24 44 40 54 50 74 C60 54 76 44 96 40'), 4.2)
    return SUB(c, hem)

def orb_v_ring():  # 17 veil solid, what's under it as a fine line
    c = circ(50, 50, 42)
    veil = P('M0 0 H100 V40 C76 44 60 54 50 74 C40 54 24 44 0 40Z')
    top = I(c, veil)
    under = SUB(ring(50, 50, 42, 3.2), grow(top, 3.2))
    return U(top, under)

def hung():  # 18 cloth hung from two pins, one fold
    body = P('M10 16 C34 30 66 30 90 16 C80 48 64 74 50 94 C36 74 20 48 10 16Z')
    fold = stroke(P('M90 16 C70 40 56 66 50 94'), 3.6)
    return SUB(body, fold)

def hung2():  # 19 two layers of cloth: back hung wide, front shorter
    back = P('M8 14 C34 30 66 30 92 14 C82 48 64 76 50 94 C36 76 18 48 8 14Z')
    front = P('M20 38 C38 50 62 50 80 38 C72 60 60 76 50 88 C40 76 28 60 20 38Z')
    return U(SUB(back, grow(front, 3.4)), front)

def drape_v():  # 20 a single sheet pinned top-right, falling left and folding back into a V
    a = P('M88 10 C76 44 62 72 50 94 C44 70 30 40 12 22 C36 30 60 26 88 10Z')
    fold = stroke(P('M12 22 C30 40 44 66 50 94'), 0.1)
    inner = P('M88 10 C66 30 54 56 50 94 L46 86 C50 58 62 32 88 10Z')
    return SUB(a, P('M50 94 C52 60 64 34 88 10 L84 12 C62 34 50 60 48 90Z'))

def eclipse_s():  # 21 crescent whose inner edge is a fabric S, hidden disc as ring
    c = circ(50, 50, 42)
    cut = P('M50 0 C82 20 50 44 70 60 C86 72 70 90 60 100 L120 100 L120 0Z')
    cut = P('M66 4 C54 22 52 40 58 54 C64 68 62 84 54 98 L120 98 L120 4Z')
    cres = SUB(c, cut)
    return U(cres, SUB(ring(50, 50, 42, 3.2), grow(cres, 3.2)))

def sail_asym():  # 22 two sails of unequal height: a quiet lowercase v
    a = P('M14 26 C12 54 28 76 49 94 C46 66 38 44 26 26Z')
    b = P('M88 8 C90 44 72 74 51 94 C54 62 62 34 76 8Z')
    return U(a, b)

def half_veil():  # 23 disc, right half drawn only as its edge: half-shown liquidity
    c = circ(50, 50, 42)
    left = I(c, P('M0 0 H47 C40 30 40 70 47 100 H0Z'))
    return U(left, SUB(ring(50, 50, 42, 3.2), grow(left, 3.2)))

def crescent_v():  # 24 two crescents back to back meeting at the base: a V of moons
    a = SUB(circ(36, 50, 40), circ(16, 44, 40))
    return a

SK += [('15', 'Occultation', occult), ('16', 'Veiled orb', orb_v), ('17', 'Orb, veil + edge', orb_v_ring), ('18', 'Hung cloth', hung),
       ('19', 'Two cloths', hung2), ('20', 'Single sheet v', drape_v), ('21', 'Eclipse S-fold', eclipse_s), ('22', 'Asym sails', sail_asym),
       ('23', 'Half-shown disc', half_veil)]
