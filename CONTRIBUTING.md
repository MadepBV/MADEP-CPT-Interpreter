# Contributing

Thanks for your interest in contributing to this project. Contributions of all
kinds are welcome — bug reports, fixes, features, documentation, and
discussion.

## License of contributions

This project is licensed under the **GNU Affero General Public License v3.0 or
later (AGPL-3.0-or-later)**. By contributing, you agree that your contributions
will be licensed under the same terms. See [LICENSE](LICENSE) for the full
text.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/)
to confirm that you have the right to submit your contributions under the
project license. We do **not** require a separate CLA.

Every commit must be signed off with your real name and email. The sign-off
is a single line at the end of the commit message:

```
Signed-off-by: Jane Doe <jane@example.com>
```

Adding the sign-off is easy — append `-s` to your `git commit`:

```sh
git commit -s -m "Fix stage 6 surcharge zone rendering"
```

To sign off on commits you've already made:

```sh
git commit --amend -s            # last commit
git rebase --signoff main        # all commits on your branch
```

Pull requests containing unsigned commits will not be merged.

### What the DCO means

By signing off, you certify that:

> (a) The contribution was created in whole or in part by me and I have the
>     right to submit it under the open source license indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best of my
>     knowledge, is covered under an appropriate open source license and I have
>     the right under that license to submit that work with modifications,
>     whether created in whole or in part by me, under the same open source
>     license (unless I am permitted to submit under a different license), as
>     indicated in the file; or
>
> (c) The contribution was provided directly to me by some other person who
>     certified (a), (b) or (c) and I have not modified it.
>
> (d) I understand and agree that this project and the contribution are public
>     and that a record of the contribution (including all personal information
>     I submit with it, including my sign-off) is maintained indefinitely and
>     may be redistributed consistent with this project or the open source
>     license(s) involved.

Full text: <https://developercertificate.org/>

## Pull request workflow

1. Fork the repo and create a branch from `main`.
2. Make your changes. Keep commits focused and descriptive.
3. Sign off every commit (`git commit -s`).
4. Open a pull request describing the change and why.

## Code style

Follow the conventions already present in the file you're editing. If you're
unsure, open an issue or draft PR first.
