# Third-party data

`data/slab-test-vectors.json` (and its input, `tools/research/vectors-input.json`) contains two slab strings
taken from the test suite of TaleSpire.Slab, used as independent decode and byte-exact round-trip checks:

| Vector          | Source                                                                                                   | Licence |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------- |
| `sb-custom-156` | https://github.com/svenboulanger/TaleSpire.Slab/blob/main/TaleSpire.Slab.Tests/SlabTests.cs             | MIT     |
| `sb-4-floors`   | https://github.com/svenboulanger/TaleSpire.Slab/blob/main/TaleSpire.Slab.Tests/SlabTests.cs             | MIT     |

TaleSpire.Slab is Copyright (c) 2021 Sven Boulanger, released under the MIT License
(https://github.com/svenboulanger/TaleSpire.Slab/blob/main/LICENSE):

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
> to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of
> the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
> THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
> IN THE SOFTWARE.

Slab strings from community sharing sites and from repositories without a licence are not included. All other slab
strings in this repository (`data/test-slabs/`, `data/calibration-slab.txt`, the tests) were produced by
Slabyrinth's own encoder. Asset ids and names refer to TaleSpire content owned by Bouncyrock Entertainment; no game
files are included.
