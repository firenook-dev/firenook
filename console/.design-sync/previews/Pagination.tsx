import { Pagination } from '@firenook/kit'

/** Full controls for large sets; simple next/previous for cursor-paged lists. */
export function Full() {
  return <Pagination page={3} setPage={() => {}} perPage={50} totalCount={12_345} />
}

export function Simple() {
  return (
    <Pagination page={1} setPage={() => {}} perPage={50} totalCount={12_345} controls="simple" />
  )
}
