// Package spake2plus implements RFC 9383 SPAKE2+-P256-SHA256-HKDF-SHA256-HMAC-SHA256
// with Pairfob Argon2id → (w0,w1,L) (no second RFC PBKDF).
package spake2plus

import (
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"math/big"

	"golang.org/x/crypto/argon2"

	"pairfob/internal/crypto/canon"
	"pairfob/internal/crypto/hkdfk"
)

var (
	curve = elliptic.P256()
	order = curve.Params().N
	// Uncompressed M, N matching RFC 9383 Appendix C transcript encodings.
	mUncompressed = mustHex("04886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f5ff355163e43ce224e0b0e65ff02ac8e5c7be09419c785e0ca547d55a12e2d20")
	nUncompressed = mustHex("04d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b4907d60aa6bfade45008a636337f5168c64d9bd36034808cd564490b1e656edbe7")
)

const Context = "pairfob-v1/spake2plus"

type Record struct {
	W0, W1 *big.Int
	L      []byte // uncompressed 65
}

func DeriveRecord(normalizedS, daemonID, pairRefHex string) Record {
	saltFull := sha256.Sum256(canon.Concat(
		canon.EncStr("pairfob-v1/pake-salt"),
		canon.EncStr(daemonID),
		canon.EncStr(pairRefHex),
	))
	expanded := argon2.IDKey([]byte(normalizedS), saltFull[:16], 3, 64*1024, 1, 80)
	w0 := os2ipMod(expanded[0:40])
	w1 := os2ipMod(expanded[40:80])
	lx, ly := curve.ScalarBaseMult(pad32(w1))
	return Record{W0: w0, W1: w1, L: elliptic.Marshal(curve, lx, ly)}
}

type Keys struct {
	KShared, ConfirmP, ConfirmV, KMain []byte
}

func ComputeKeys(ctx, idP, idV string, shareP, shareV, Z, V []byte, w0 *big.Int) Keys {
	if ctx == "" {
		ctx = Context
	}
	tt := canon.Concat(
		canon.EncStr(ctx),
		canon.EncStr(idP),
		canon.EncStr(idV),
		lenPref(mUncompressed),
		lenPref(nUncompressed),
		lenPref(shareP),
		lenPref(shareV),
		lenPref(Z),
		lenPref(V),
		lenPref(pad32(w0)),
	)
	sum := sha256.Sum256(tt)
	kMain := sum[:]
	conf := hkdfk.HKDF(kMain, nil, []byte("ConfirmationKeys"), 64)
	return Keys{
		KMain:    kMain,
		KShared:  hkdfk.HKDF(kMain, nil, []byte("SharedKey"), 32),
		ConfirmP: hkdfk.HMACSHA256(conf[:32], shareV),
		ConfirmV: hkdfk.HMACSHA256(conf[32:], shareP),
	}
}

func ConfirmEqual(a, b []byte) bool {
	return subtle.ConstantTimeCompare(a, b) == 1
}

type Prover struct {
	W0, W1            *big.Int
	x                 *big.Int
	ShareP            []byte
	idP, idV, context string
}

func NewProver(rec Record, idProver, idVerifier, context string) *Prover {
	if context == "" {
		context = Context
	}
	return &Prover{W0: rec.W0, W1: rec.W1, idP: idProver, idV: idVerifier, context: context}
}

func (p *Prover) Start() []byte { return p.StartWithX(randomScalar()) }

func (p *Prover) StartWithX(x *big.Int) []byte {
	p.x = x
	mx, my := mustUnmarshal(mUncompressed)
	wMx, wMy := curve.ScalarMult(mx, my, pad32(p.W0))
	bx, by := curve.ScalarBaseMult(pad32(x))
	sx, sy := curve.Add(bx, by, wMx, wMy)
	p.ShareP = elliptic.Marshal(curve, sx, sy)
	return p.ShareP
}

func (p *Prover) Finish(shareV []byte) (Keys, error) {
	Yx, Yy, err := unmarshal(shareV)
	if err != nil {
		return Keys{}, err
	}
	nx, ny := mustUnmarshal(nUncompressed)
	wNx, wNy := curve.ScalarMult(nx, ny, pad32(p.W0))
	nNx, nNy := neg(wNx, wNy)
	tx, ty := curve.Add(Yx, Yy, nNx, nNy)
	Zx, Zy := curve.ScalarMult(tx, ty, pad32(p.x))
	Vx, Vy := curve.ScalarMult(tx, ty, pad32(p.W1))
	return ComputeKeys(p.context, p.idP, p.idV, p.ShareP, shareV,
		elliptic.Marshal(curve, Zx, Zy), elliptic.Marshal(curve, Vx, Vy), p.W0), nil
}

type Verifier struct {
	W0                *big.Int
	L                 []byte
	y                 *big.Int
	ShareV            []byte
	idP, idV, context string
}

func NewVerifier(rec Record, idProver, idVerifier, context string) *Verifier {
	if context == "" {
		context = Context
	}
	return &Verifier{W0: rec.W0, L: rec.L, idP: idProver, idV: idVerifier, context: context}
}

func (v *Verifier) Finish(shareP []byte) (shareV []byte, keys Keys, err error) {
	return v.FinishWithY(shareP, randomScalar())
}

func (v *Verifier) FinishWithY(shareP []byte, y *big.Int) (shareV []byte, keys Keys, err error) {
	Xx, Xy, err := unmarshal(shareP)
	if err != nil {
		return nil, Keys{}, err
	}
	v.y = y
	nx, ny := mustUnmarshal(nUncompressed)
	wNx, wNy := curve.ScalarMult(nx, ny, pad32(v.W0))
	bx, by := curve.ScalarBaseMult(pad32(y))
	Yx, Yy := curve.Add(bx, by, wNx, wNy)
	v.ShareV = elliptic.Marshal(curve, Yx, Yy)

	mx, my := mustUnmarshal(mUncompressed)
	wMx, wMy := curve.ScalarMult(mx, my, pad32(v.W0))
	nMx, nMy := neg(wMx, wMy)
	tx, ty := curve.Add(Xx, Xy, nMx, nMy)
	Zx, Zy := curve.ScalarMult(tx, ty, pad32(y))
	Lx, Ly, err := unmarshal(v.L)
	if err != nil {
		return nil, Keys{}, err
	}
	Vx, Vy := curve.ScalarMult(Lx, Ly, pad32(y))
	keys = ComputeKeys(v.context, v.idP, v.idV, shareP, v.ShareV,
		elliptic.Marshal(curve, Zx, Zy), elliptic.Marshal(curve, Vx, Vy), v.W0)
	return v.ShareV, keys, nil
}

func IdProver(pairRefHex string) string { return "phone" + pairRefHex }

func os2ipMod(b []byte) *big.Int {
	n := new(big.Int).SetBytes(b)
	return n.Mod(n, order)
}

func pad32(n *big.Int) []byte {
	b := n.Bytes()
	if len(b) > 32 {
		b = b[len(b)-32:]
	}
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

func unmarshal(b []byte) (x, y *big.Int, err error) {
	x, y = elliptic.Unmarshal(curve, b)
	if x == nil {
		return nil, nil, errors.New("invalid P-256 point")
	}
	return x, y, nil
}

func mustUnmarshal(b []byte) (x, y *big.Int) {
	x, y, err := unmarshal(b)
	if err != nil {
		panic(err)
	}
	return x, y
}

func neg(x, y *big.Int) (*big.Int, *big.Int) {
	yy := new(big.Int).Neg(y)
	yy.Mod(yy, curve.Params().P)
	return new(big.Int).Set(x), yy
}

func randomScalar() *big.Int {
	for {
		k, err := rand.Int(rand.Reader, order)
		if err != nil {
			panic(err)
		}
		if k.Sign() != 0 {
			return k
		}
	}
}

func lenPref(b []byte) []byte {
	out := make([]byte, 8+len(b))
	n := uint64(len(b))
	for i := 0; i < 8; i++ {
		out[i] = byte(n >> (8 * i))
	}
	copy(out[8:], b)
	return out
}

func mustHex(s string) []byte {
	b := make([]byte, len(s)/2)
	for i := 0; i < len(b); i++ {
		var v byte
		for _, c := range []byte{s[2*i], s[2*i+1]} {
			v <<= 4
			switch {
			case c >= '0' && c <= '9':
				v |= c - '0'
			case c >= 'a' && c <= 'f':
				v |= c - 'a' + 10
			case c >= 'A' && c <= 'F':
				v |= c - 'A' + 10
			}
		}
		b[i] = v
	}
	return b
}

func ScalarFromHex(s string) *big.Int {
	n := new(big.Int)
	n.SetString(s, 16)
	return n
}

func RecordFromHex(w0, w1, L string) Record {
	return Record{W0: ScalarFromHex(w0), W1: ScalarFromHex(w1), L: mustHex(L)}
}
